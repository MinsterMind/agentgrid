import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
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

beforeEach(() => vi.clearAllMocks());

describe("BugLauncher", () => {
  it("lists my open bugs and starts one, pre-filling the remembered repo", async () => {
    const onCreated = vi.fn();
    render(<BugLauncher onCreated={onCreated} onClose={vi.fn()} />);
    await waitFor(() => expect(screen.getByText(/Refresh token rotates twice/)).toBeInTheDocument());
    await userEvent.click(screen.getByRole("button", { name: /PAY-42/ }));
    expect(screen.getByLabelText("Repo")).toHaveValue("/r/payments");     // remembered for project PAY
    await waitFor(() => expect(bugPreflight).toHaveBeenCalledWith("/r/payments"));
    await userEvent.click(screen.getByRole("button", { name: "Start fixing" }));
    expect(createBugTask).toHaveBeenCalledWith({ issueRef: "PAY-42", repo: "/r/payments", mergePolicy: "ask" });
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith(expect.objectContaining({ id: "bt1" })));
  });

  it("accepts a pasted issue URL instead of the list", async () => {
    render(<BugLauncher onCreated={vi.fn()} onClose={vi.fn()} />);
    await userEvent.type(screen.getByLabelText("Issue URL or key"), "https://x/browse/WEB-9");
    await userEvent.clear(screen.getByLabelText("Repo"));
    await userEvent.type(screen.getByLabelText("Repo"), "/r/web");
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

  it("surfaces a failed issue lookup instead of silently doing nothing", async () => {
    createBugTask.mockRejectedValueOnce(new Error("tracker returned no usable JSON"));
    render(<BugLauncher onCreated={vi.fn()} onClose={vi.fn()} />);
    await userEvent.type(screen.getByLabelText("Issue URL or key"), "PAY-42");
    await userEvent.type(screen.getByLabelText("Repo"), "/r/payments");
    await userEvent.click(screen.getByRole("button", { name: "Start fixing" }));
    await waitFor(() => expect(screen.getByText(/no usable JSON/)).toBeInTheDocument());
  });

  it("says so when the tracker is not connected", async () => {
    myIssues.mockRejectedValueOnce(new Error("the bug-fix workflow is not configured"));
    render(<BugLauncher onCreated={vi.fn()} onClose={vi.fn()} />);
    await waitFor(() => expect(screen.getByText(/not configured/)).toBeInTheDocument());
  });
});
