import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { BugLauncher } from "../src/components/BugLauncher";

const myIssues = vi.fn(async () => [{ key: "PAY-42", title: "Refresh token rotates twice", url: "u", status: "Open", priority: "High" }]);
const bugPreflight = vi.fn(async (_repo: string) => ({ ok: true, problems: [] as string[] }));
const createBugTask = vi.fn(async (i: { issueRef: string; repo: string }) => ({ id: "bt1", ...i }));
const getIntegrations = vi.fn(async () => ({ projectRepos: { PAY: "/r/payments" } }));
vi.mock("../src/api", () => ({ api: {
  myIssues: () => myIssues(), bugPreflight: (r: string) => bugPreflight(r),
  createBugTask: (i: never) => createBugTask(i), getIntegrations: () => getIntegrations(),
  pickFolder: vi.fn(async () => ({ path: "/r/picked" })),
} }));

beforeEach(() => {
  vi.clearAllMocks();
  bugPreflight.mockImplementation(async (_repo: string) => ({ ok: true, problems: [] as string[] }));
});

describe("BugLauncher", () => {
  it("lists my open bugs and starts one, pre-filling the remembered repo", async () => {
    const onCreated = vi.fn();
    render(<BugLauncher onCreated={onCreated} onClose={vi.fn()} />);
    await waitFor(() => expect(screen.getByText(/Refresh token rotates twice/)).toBeInTheDocument());
    await userEvent.click(screen.getByRole("button", { name: /PAY-42/ }));
    expect(screen.getByLabelText("Repo")).toHaveValue("/r/payments");     // remembered for project PAY
    await waitFor(() => expect(bugPreflight).toHaveBeenCalledWith("/r/payments"));
    await waitFor(() => expect(screen.getByRole("button", { name: "Start fixing" })).not.toBeDisabled());
    await userEvent.click(screen.getByRole("button", { name: "Start fixing" }));
    expect(createBugTask).toHaveBeenCalledWith({ issueRef: "PAY-42", repo: "/r/payments", mergePolicy: "ask" });
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith(expect.objectContaining({ id: "bt1" })));
  });

  it("accepts a pasted issue URL instead of the list", async () => {
    render(<BugLauncher onCreated={vi.fn()} onClose={vi.fn()} />);
    await userEvent.type(screen.getByLabelText("Issue URL or key"), "https://x/browse/WEB-9");
    await userEvent.clear(screen.getByLabelText("Repo"));
    await userEvent.type(screen.getByLabelText("Repo"), "/r/web");
    await waitFor(() => expect(bugPreflight).toHaveBeenCalledWith("/r/web"));
    await waitFor(() => expect(screen.getByRole("button", { name: "Start fixing" })).not.toBeDisabled());
    await userEvent.click(screen.getByRole("button", { name: "Start fixing" }));
    expect(createBugTask).toHaveBeenCalledWith({ issueRef: "https://x/browse/WEB-9", repo: "/r/web", mergePolicy: "ask" });
  });

  it("blocks starting while preflight has problems and shows them", async () => {
    bugPreflight.mockResolvedValueOnce({ ok: false, problems: ["forge not authenticated: run gh auth login"] });
    render(<BugLauncher onCreated={vi.fn()} onClose={vi.fn()} />);
    await userEvent.type(screen.getByLabelText("Issue URL or key"), "PAY-42");
    await userEvent.type(screen.getByLabelText("Repo"), "/r/payments");
    await waitFor(() => expect(screen.getByText(/gh auth login/)).toBeInTheDocument());
    expect(screen.getByRole("button", { name: "Start fixing" })).toBeDisabled();
  });

  it("disables Start before any preflight check has run for a freshly-entered repo", async () => {
    bugPreflight.mockImplementation(() => new Promise(() => {})); // never resolves within the test
    render(<BugLauncher onCreated={vi.fn()} onClose={vi.fn()} />);
    await userEvent.type(screen.getByLabelText("Issue URL or key"), "PAY-42");
    await userEvent.type(screen.getByLabelText("Repo"), "/r/payments");
    expect(screen.getByRole("button", { name: "Start fixing" })).toBeDisabled();
    await waitFor(() => expect(screen.getByText(/Checking repo/)).toBeInTheDocument());
  });

  it("disables Start when the repo changes after a successful preflight, until the new check resolves", async () => {
    render(<BugLauncher onCreated={vi.fn()} onClose={vi.fn()} />);
    await userEvent.type(screen.getByLabelText("Issue URL or key"), "PAY-42");
    await userEvent.type(screen.getByLabelText("Repo"), "/r/payments");
    await waitFor(() => expect(bugPreflight).toHaveBeenCalledWith("/r/payments"));
    await waitFor(() => expect(screen.getByRole("button", { name: "Start fixing" })).not.toBeDisabled());

    let resolveSecond: (v: { ok: boolean; problems: string[] }) => void = () => {};
    bugPreflight.mockImplementationOnce(() => new Promise(res => { resolveSecond = res; }));

    await userEvent.clear(screen.getByLabelText("Repo"));
    await userEvent.type(screen.getByLabelText("Repo"), "/r/other");
    // The stale "ok" result from /r/payments must not leak into the field's new value.
    expect(screen.getByRole("button", { name: "Start fixing" })).toBeDisabled();

    await waitFor(() => expect(bugPreflight).toHaveBeenCalledWith("/r/other"));
    resolveSecond({ ok: true, problems: [] });
    await waitFor(() => expect(screen.getByRole("button", { name: "Start fixing" })).not.toBeDisabled());
  });

  it("keeps Start disabled for a relative repo path and never checks or starts it", async () => {
    render(<BugLauncher onCreated={vi.fn()} onClose={vi.fn()} />);
    await userEvent.type(screen.getByLabelText("Issue URL or key"), "PAY-42");
    await userEvent.type(screen.getByLabelText("Repo"), "myrepo");
    expect(screen.getByText(/absolute repo path/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Start fixing" })).toBeDisabled();
    expect(bugPreflight).not.toHaveBeenCalled();
    expect(createBugTask).not.toHaveBeenCalled();
  });

  it("surfaces a failed issue lookup instead of silently doing nothing", async () => {
    createBugTask.mockRejectedValueOnce(new Error("tracker returned no usable JSON"));
    render(<BugLauncher onCreated={vi.fn()} onClose={vi.fn()} />);
    await userEvent.type(screen.getByLabelText("Issue URL or key"), "PAY-42");
    await userEvent.type(screen.getByLabelText("Repo"), "/r/payments");
    await waitFor(() => expect(screen.getByRole("button", { name: "Start fixing" })).not.toBeDisabled());
    await userEvent.click(screen.getByRole("button", { name: "Start fixing" }));
    await waitFor(() => expect(screen.getByText(/no usable JSON/)).toBeInTheDocument());
  });

  it("says so, within the issue-list section, when the tracker is not connected", async () => {
    myIssues.mockRejectedValueOnce(new Error("the bug-fix workflow is not configured"));
    render(<BugLauncher onCreated={vi.fn()} onClose={vi.fn()} />);
    const section = screen.getByText("My open bugs").closest(".bugs");
    expect(section).not.toBeNull();
    await waitFor(() => expect(within(section as HTMLElement).getByText(/not configured/)).toBeInTheDocument());
  });
});
