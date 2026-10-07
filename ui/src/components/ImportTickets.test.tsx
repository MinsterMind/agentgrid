import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ImportTickets, parseKeys } from "./ImportTickets";
import { api } from "../api";

beforeEach(() => vi.restoreAllMocks());

describe("ImportTickets (spec 2026-10-09 §3)", () => {
  it("parses keys from commas, spaces and lines, upper-cased and deduped", () => {
    expect(parseKeys("pay-1, PAY-2\nPAY-1  ops-10 nonsense")).toEqual(["PAY-1", "PAY-2", "OPS-10"]);
  });
  it("imports the keys into the checked repo and shows each result, including a choice", async () => {
    vi.spyOn(api, "getIntegrations").mockResolvedValue({ projectRepos: { PAY: "/r" } } as never);
    vi.spyOn(api, "bugPreflight").mockResolvedValue({ ok: true, problems: [] });
    const start = vi.spyOn(api, "startImport").mockResolvedValue({ importId: "i1" });
    const choose = vi.spyOn(api, "chooseImport").mockResolvedValue({} as never);
    const { rerender } = render(<ImportTickets imports={{}} onClose={() => {}} />);
    await userEvent.type(screen.getByLabelText("Ticket keys"), "PAY-1 PAY-2 PAY-3");
    await waitFor(() => expect((screen.getByLabelText("Repo") as HTMLInputElement).value).toBe("/r"));
    const go = screen.getByRole("button", { name: "Import 3 tickets" });
    await waitFor(() => expect(go).toBeEnabled());
    await userEvent.click(go);
    expect(start).toHaveBeenCalledWith(["PAY-1", "PAY-2", "PAY-3"], "/r");
    rerender(<ImportTickets imports={{ i1: { importId: "i1", total: 3, done: 3, finished: true,
      imported: [{ key: "PAY-1", taskId: "bt1", stage: "monitoring" }],
      choose: [{ key: "PAY-2", candidates: [{ number: 3, title: "a", branch: "a/PAY-2", url: "u3" }, { number: 5, title: "b", branch: "b/PAY-2", url: "u5" }] }],
      skipped: [{ key: "PAY-3", message: "PAY-3 is already in AgentGrid (bt9)" }], failed: [] } }} onClose={() => {}} />);
    expect(screen.getByText(/Imported 1 of 3/)).toBeTruthy();
    expect(screen.getByText(/Watching the PR/)).toBeTruthy();
    await userEvent.click(screen.getByLabelText(/#5 — b \(b\/PAY-2\)/));
    await userEvent.click(screen.getByRole("button", { name: "Use #5 for PAY-2" }));
    expect(choose).toHaveBeenCalledWith("i1", "PAY-2", 5);
    expect(screen.getByText(/already in AgentGrid \(bt9\)/)).toBeTruthy();
  });
  it("can't import until the repo checks out", async () => {
    vi.spyOn(api, "getIntegrations").mockResolvedValue({ projectRepos: {} } as never);
    vi.spyOn(api, "bugPreflight").mockResolvedValue({ ok: false, problems: ["this repo has no `origin` remote"] });
    render(<ImportTickets imports={{}} onClose={() => {}} />);
    await userEvent.type(screen.getByLabelText("Ticket keys"), "PAY-1");
    await userEvent.type(screen.getByLabelText("Repo"), "/x");
    expect(await screen.findByText(/no `origin` remote/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Import 1 ticket" })).toBeDisabled();
  });
  it("a failed key can be retried on its own", async () => {
    vi.spyOn(api, "getIntegrations").mockResolvedValue({ projectRepos: { PAY: "/r" } } as never);
    vi.spyOn(api, "bugPreflight").mockResolvedValue({ ok: true, problems: [] });
    const start = vi.spyOn(api, "startImport").mockResolvedValue({ importId: "i1" });
    const { rerender } = render(<ImportTickets imports={{}} onClose={() => {}} />);
    await userEvent.type(screen.getByLabelText("Ticket keys"), "PAY-1");
    await waitFor(() => expect(screen.getByRole("button", { name: "Import 1 ticket" })).toBeEnabled());
    await userEvent.click(screen.getByRole("button", { name: "Import 1 ticket" }));
    rerender(<ImportTickets imports={{ i1: { importId: "i1", total: 1, done: 1, finished: true, imported: [], choose: [], skipped: [], failed: [{ key: "PAY-1", message: "leftover worktree" }] } }} onClose={() => {}} />);
    await userEvent.click(screen.getByRole("button", { name: "Retry PAY-1" }));
    expect(start).toHaveBeenLastCalledWith(["PAY-1"], "/r");
  });
});
