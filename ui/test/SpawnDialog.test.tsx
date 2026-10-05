import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SpawnDialog } from "../src/components/SpawnDialog";
import type { RoleDef } from "../src/types";

const tree: Record<string, { root: string; path: string; parent: string | null; entries: Array<{ name: string; path: string; isRepo: boolean }> }> = {
  "": { root: "/home/u", path: "/home/u", parent: null, entries: [
    { name: "payments", path: "/home/u/payments", isRepo: true },
    { name: "work", path: "/home/u/work", isRepo: false },
  ] },
  "/home/u/work": { root: "/home/u", path: "/home/u/work", parent: "/home/u", entries: [
    { name: "hrns", path: "/home/u/work/hrns", isRepo: true },
  ] },
  "/home/u/work/hrns": { root: "/home/u", path: "/home/u/work/hrns", parent: "/home/u/work", entries: [] },
};
tree["/home/u"] = tree[""];
const pickFolder = vi.fn<() => Promise<{ path: string } | undefined>>();
const repoStatus = vi.fn(async (_p: string): Promise<unknown> => null);
vi.mock("../src/api", () => ({ api: { listDir: vi.fn(async (p?: string) => tree[p ?? ""]), pickFolder: () => pickFolder(), repoStatus: (p: string) => repoStatus(p) } }));

const roles: RoleDef[] = [{ name: "coder", avatar: "👩‍💻", model: "m", effort: "high", permissionMode: "default", settingSources: [], allowedTools: [], maxTurns: 1, prompt: "", description: "" }];
const props = () => ({ roles, recentRepos: [], onSpawn: vi.fn(async () => {}), onClose: vi.fn() });
const openPanel = () => userEvent.click(screen.getByRole("button", { name: /show folder list/i }));
beforeEach(() => { vi.clearAllMocks(); pickFolder.mockReset(); repoStatus.mockReset(); repoStatus.mockResolvedValue(null); });

describe("SpawnDialog native picker", () => {
  it("panel is collapsed by default; Browse… uses the native picker and fills the path", async () => {
    pickFolder.mockResolvedValue({ path: "/home/u/payments" });
    render(<SpawnDialog {...props()} />);
    expect(screen.queryByRole("button", { name: /payments/ })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Browse…" }));
    expect(screen.getByPlaceholderText("/Users/you/project")).toHaveValue("/home/u/payments");
    expect(screen.queryByRole("button", { name: /^work$/ })).toBeNull(); // still collapsed
  });
  it("cancelling the native picker leaves the field alone", async () => {
    pickFolder.mockResolvedValue(undefined);
    render(<SpawnDialog {...props()} />);
    await userEvent.click(screen.getByRole("button", { name: "Browse…" }));
    expect(screen.getByPlaceholderText("/Users/you/project")).toHaveValue("");
  });
  it("falls back to the inline panel when the native picker is unavailable", async () => {
    pickFolder.mockRejectedValue(new Error("native folder picker is macOS only"));
    render(<SpawnDialog {...props()} />);
    await userEvent.click(screen.getByRole("button", { name: "Browse…" }));
    expect(await screen.findByRole("button", { name: /payments/ })).toBeInTheDocument();
  });
});

describe("SpawnDialog repo browser", () => {
  it("lists the root on open with repos badged", async () => {
    render(<SpawnDialog {...props()} />); await openPanel();
    await waitFor(() => expect(screen.getByRole("button", { name: /payments/ })).toBeInTheDocument());
    expect(screen.getByRole("button", { name: /payments/ })).toHaveTextContent("git");
    expect(screen.getByRole("button", { name: /^work$/ })).not.toHaveTextContent("git");
  });

  it("clicking a plain folder descends; breadcrumb and up navigate back", async () => {
    render(<SpawnDialog {...props()} />); await openPanel();
    await userEvent.click(await screen.findByRole("button", { name: /^work$/ }));
    expect(await screen.findByRole("button", { name: /hrns/ })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "⬆ up" }));
    expect(await screen.findByRole("button", { name: /^work$/ })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /^work$/ }));
    await screen.findByRole("button", { name: /hrns/ });
    expect(screen.queryByRole("button", { name: "home" })).toBeNull(); // nothing above the browse root
    await userEvent.click(screen.getByRole("button", { name: "u" })); // breadcrumb segment for /home/u (the root)
    expect(await screen.findByRole("button", { name: /payments/ })).toBeInTheDocument();
  });

  it("clicking a repo folder fills the path field; spawn uses it", async () => {
    const p = props();
    render(<SpawnDialog {...p} />); await openPanel();
    await userEvent.click(await screen.findByRole("button", { name: /payments/ }));
    expect(screen.getByPlaceholderText("/Users/you/project")).toHaveValue("/home/u/payments");
    await userEvent.click(screen.getByRole("button", { name: "Create agent" }));
    expect(p.onSpawn).toHaveBeenCalledWith({ role: "coder", repo: "/home/u/payments", displayName: undefined });
  });

  it("'Use this folder' selects the current directory", async () => {
    render(<SpawnDialog {...props()} />); await openPanel();
    await userEvent.click(await screen.findByRole("button", { name: /^work$/ }));
    await screen.findByRole("button", { name: /hrns/ });
    await userEvent.click(screen.getByRole("button", { name: /use this folder/i }));
    expect(screen.getByPlaceholderText("/Users/you/project")).toHaveValue("/home/u/work");
  });
});

const role = (name: string, extra: Partial<RoleDef> = {}): RoleDef => ({ name, avatar: "🤖", model: "claude-opus-5", effort: "high", permissionMode: "default", settingSources: [], allowedTools: [], maxTurns: 1, prompt: "", description: "", ...extra });
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

describe("New agent dialog", () => {
  it("offers roles as cards that say what each does and which model it uses", () => {
    render(<SpawnDialog roles={[role("coder", { description: "Writes and changes code." })]} recentRepos={[]} onSpawn={vi.fn()} onClose={vi.fn()} />);
    const card = screen.getByRole("radio", { name: /coder/i });
    expect(card).toHaveTextContent("Writes and changes code.");
    expect(card).toHaveTextContent(/claude-opus-5/);
    expect(card).toHaveAttribute("aria-checked", "true");
  });

  // Review Focus 2
  it("says what the chosen folder is, debounced, ignoring a late answer for an older path", async () => {
    let resolveOld!: (v: unknown) => void;
    repoStatus.mockImplementationOnce(() => new Promise(r => { resolveOld = r; }))
      .mockResolvedValueOnce({ exists: true, isRepo: true, branch: "main" });
    render(<SpawnDialog roles={[role("coder")]} recentRepos={[]} onSpawn={vi.fn()} onClose={vi.fn()} />);
    const input = screen.getByPlaceholderText("/Users/you/project");
    await userEvent.type(input, "/r/old"); await sleep(350);
    await userEvent.clear(input); await userEvent.type(input, "/r/new"); await sleep(350);
    resolveOld({ exists: false, isRepo: false, branch: null });
    expect(await screen.findByTestId("repo-status")).toHaveTextContent("Git repo on main");
    await sleep(50);
    expect(screen.getByTestId("repo-status")).toHaveTextContent("Git repo on main");
    expect(repoStatus).toHaveBeenCalledTimes(2);
  });

  it.each([
    [{ exists: true, isRepo: false, branch: null }, "Not a git repo — the agent can still work here"],
    [{ exists: false, isRepo: false, branch: null }, "Folder not found"],
    [{ exists: true, isRepo: true, branch: "dev" }, "Git repo on dev"],
    [{ exists: true, isRepo: true, branch: null }, "Git repo (detached HEAD)"],
  ])("describes %o", async (st, text) => {
    repoStatus.mockResolvedValue(st);
    render(<SpawnDialog roles={[role("coder")]} recentRepos={["/r/x"]} onSpawn={vi.fn()} onClose={vi.fn()} />);
    expect(await screen.findByTestId("repo-status")).toHaveTextContent(text);
  });

  it("creates the agent with an optional first task", async () => {
    const onSpawn = vi.fn(async () => {});
    render(<SpawnDialog roles={[role("coder")]} recentRepos={["/r/x"]} onSpawn={onSpawn} onClose={vi.fn()} />);
    await userEvent.type(screen.getByLabelText(/first task/i), "Add tests");
    await userEvent.click(screen.getByRole("button", { name: "Create agent" }));
    expect(onSpawn).toHaveBeenCalledWith({ role: "coder", repo: "/r/x", displayName: undefined, task: "Add tests" });
  });
});

