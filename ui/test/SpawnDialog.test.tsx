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
vi.mock("../src/api", () => ({ api: { listDir: vi.fn(async (p?: string) => tree[p ?? ""]) } }));

const roles: RoleDef[] = [{ name: "coder", avatar: "👩‍💻", model: "m", effort: "high", permissionMode: "default", settingSources: [], allowedTools: [], maxTurns: 1, prompt: "" }];
const props = () => ({ roles, recentRepos: [], onSpawn: vi.fn(async () => {}), onClose: vi.fn() });
beforeEach(() => vi.clearAllMocks());

describe("SpawnDialog repo browser", () => {
  it("lists the root on open with repos badged", async () => {
    render(<SpawnDialog {...props()} />);
    await waitFor(() => expect(screen.getByRole("button", { name: /payments/ })).toBeInTheDocument());
    expect(screen.getByRole("button", { name: /payments/ })).toHaveTextContent("git");
    expect(screen.getByRole("button", { name: /^work$/ })).not.toHaveTextContent("git");
  });

  it("clicking a plain folder descends; breadcrumb and up navigate back", async () => {
    render(<SpawnDialog {...props()} />);
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
    render(<SpawnDialog {...p} />);
    await userEvent.click(await screen.findByRole("button", { name: /payments/ }));
    expect(screen.getByPlaceholderText("/Users/you/project")).toHaveValue("/home/u/payments");
    await userEvent.click(screen.getByRole("button", { name: "Spawn" }));
    expect(p.onSpawn).toHaveBeenCalledWith({ role: "coder", repo: "/home/u/payments", displayName: undefined });
  });

  it("'Use this folder' selects the current directory", async () => {
    render(<SpawnDialog {...props()} />);
    await userEvent.click(await screen.findByRole("button", { name: /^work$/ }));
    await screen.findByRole("button", { name: /hrns/ });
    await userEvent.click(screen.getByRole("button", { name: /use this folder/i }));
    expect(screen.getByPlaceholderText("/Users/you/project")).toHaveValue("/home/u/work");
  });
});
