import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { BulkStart } from "../src/components/BulkStart";

const startBatch = vi.fn(async (_items: unknown, _anyway?: string[]) => ({ batchId: "b1" }));
const okPreflight = async (repo: string) => ({ ok: true, problems: [] as string[], baseBranch: repo.includes("ops") ? "main" : "develop", branches: ["develop", "main"] });
const bugPreflight = vi.fn(okPreflight);
vi.mock("../src/api", () => ({ api: {
  startBatch: (i: unknown, a?: string[]) => startBatch(i, a), bugPreflight: (r: string) => bugPreflight(r),
  getIntegrations: async () => ({ projectRepos: { PAY: "/r/pay", OPS: "/r/ops" } }), pickFolder: vi.fn(),
} }));
beforeEach(() => { vi.clearAllMocks(); bugPreflight.mockImplementation(okPreflight); });
const I = (key: string, title = key) => ({ key, title, url: "u", status: "Open", priority: "High" });

describe("BulkStart", () => {
  it("groups by project, with each project's remembered repo; Start waits for every repo to check out", async () => {
    render(<BulkStart selected={[I("PAY-1"), I("PAY-2"), I("OPS-7")]} batches={{}} />);
    expect(await screen.findByLabelText("Repo for PAY")).toHaveValue("/r/pay");
    expect(screen.getByLabelText("Repo for OPS")).toHaveValue("/r/ops");
    await waitFor(() => expect(screen.getByLabelText("Branch from for PAY")).toHaveValue("develop"));
    await waitFor(() => expect(screen.getByRole("button", { name: "Start 3 fixes" })).not.toBeDisabled());
    await userEvent.click(screen.getByRole("button", { name: "Start 3 fixes" }));
    expect(startBatch).toHaveBeenCalledWith([
      { issueRef: "PAY-1", repo: "/r/pay", baseBranch: "develop" }, { issueRef: "PAY-2", repo: "/r/pay", baseBranch: "develop" },
      { issueRef: "OPS-7", repo: "/r/ops", baseBranch: "main" }], undefined);
  });
  it("a repo that fails its check holds Start back, and says why", async () => {
    bugPreflight.mockImplementation(async () => ({ ok: false, problems: ["this repo has no `origin` remote"] }) as never);
    render(<BulkStart selected={[I("PAY-1")]} batches={{}} />);
    expect(await screen.findByText(/no `origin` remote/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Start 1 fix" })).toBeDisabled();
  });
  it("shows progress, what was skipped and failed — Start anyway and Retry send them again", async () => {
    const { rerender } = render(<BulkStart selected={[I("PAY-1"), I("PAY-2"), I("PAY-3")]} batches={{}} />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Start 3 fixes" })).not.toBeDisabled());
    await userEvent.click(screen.getByRole("button", { name: "Start 3 fixes" }));
    rerender(<BulkStart selected={[I("PAY-1"), I("PAY-2"), I("PAY-3")]} batches={{ b1: { batchId: "b1", total: 3, done: 3, finished: true,
      started: [{ key: "PAY-1", taskId: "bt1" }], skipped: [{ key: "PAY-2", message: "PAY-2 may already be fixed: … abc123 PAY-2: fix" }], failed: [{ key: "PAY-3", message: "couldn't read PAY-3 from the tracker" }] } }} />);
    expect(screen.getByText("Started 1 of 3")).toBeInTheDocument();
    const skipped = screen.getByRole("region", { name: /may already be fixed/i });
    expect(skipped).toHaveTextContent("abc123 PAY-2: fix");
    await userEvent.click(within(skipped).getByRole("button", { name: "Start all anyway" }));
    expect(startBatch).toHaveBeenLastCalledWith([{ issueRef: "PAY-2", repo: "/r/pay", baseBranch: "develop" }], ["PAY-2"]);
    const failed = screen.getByRole("region", { name: /failed/i });
    expect(failed).toHaveTextContent("couldn't read PAY-3 from the tracker");
    await userEvent.click(within(failed).getByRole("button", { name: "Retry PAY-3" }));
    expect(startBatch).toHaveBeenLastCalledWith([{ issueRef: "PAY-3", repo: "/r/pay", baseBranch: "develop" }], undefined);
  });
});

describe("BulkStart — typing a repo (final review #1)", () => {
  it("typing a path character by character still checks the final path, and Start enables", async () => {
    // A real check takes a while: keystrokes land while one is in flight.
    bugPreflight.mockImplementation(async (repo: string) => { await new Promise(r => setTimeout(r, 40)); return okPreflight(repo); });
    render(<BulkStart selected={[I("NEW-1")]} batches={{}} />);       // no remembered repo for NEW
    const input = await screen.findByLabelText("Repo for NEW");
    await userEvent.type(input, "/r/new");
    await waitFor(() => expect(screen.getByRole("button", { name: "Start 1 fix" })).not.toBeDisabled());
    expect(screen.queryByText("Checking repo…")).toBeNull();
    expect(bugPreflight).toHaveBeenLastCalledWith("/r/new");
  });
});
