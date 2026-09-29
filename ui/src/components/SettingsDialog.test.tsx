import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SettingsDialog } from "./SettingsDialog";
import { api } from "../api";

const report = (over: Partial<import("../types").SetupReport> = {}): import("../types").SetupReport => ({
  ready: false, wired: false, addCommand: "claude mcp add --transport http atlassian https://mcp.atlassian.com/v1/mcp",
  checks: [{ id: "tracker", state: "missing", detail: "No tracker configured.", blocks: true }],
  discovery: { importable: [], accountOnly: [], problems: [] }, ...over,
});

beforeEach(() => vi.restoreAllMocks());

describe("SettingsDialog", () => {
  it("shows the add command when only an account connector exists, and explains why", async () => {
    vi.spyOn(api, "getSetup").mockResolvedValue(report({
      checks: [{ id: "tracker", state: "missing", blocks: true,
        detail: "No tracker configured. 1 connector(s) are linked to your Claude account, but account connectors keep their definition server-side — there is nothing to import. Add a local one, then press Detect.",
        fix: { kind: "command", value: "claude mcp add --transport http atlassian https://mcp.atlassian.com/v1/mcp" } }],
      discovery: { importable: [], accountOnly: ["claude.ai Claude Docs"], problems: [] },
    }));
    render(<SettingsDialog onClose={() => {}} />);
    expect(await screen.findByText(/keep their definition server-side/)).toBeTruthy();
    expect(screen.getByText(/^claude mcp add --transport http/)).toBeTruthy();
  });

  it("offers Import for a discovered server and re-renders from the response", async () => {
    vi.spyOn(api, "getSetup").mockResolvedValue(report({
      discovery: { importable: [{ name: "atlassian", type: "http", url: "https://mcp.atlassian.com/v1/mcp", origin: "user" }], accountOnly: [], problems: [] },
    }));
    const imported = vi.spyOn(api, "importMcpServer").mockResolvedValue(report({
      ready: true, wired: true, checks: [{ id: "tracker", state: "ok", detail: "Tracker configured (mcp, tools mcp__atlassian).", blocks: true }],
    }));
    render(<SettingsDialog onClose={() => {}} />);
    await userEvent.click(await screen.findByRole("button", { name: /import/i }));
    expect(imported).toHaveBeenCalledWith("atlassian");
    await waitFor(() => expect(screen.getByText(/Tracker configured/)).toBeTruthy());
  });

  it("reports a failed test with the provider's own words", async () => {
    vi.spyOn(api, "getSetup").mockResolvedValue(report());
    vi.spyOn(api, "testTracker").mockResolvedValue({ ok: false, message: "MCP server atlassian is not connected" });
    render(<SettingsDialog onClose={() => {}} />);
    await userEvent.click(await screen.findByRole("button", { name: /^test$/i }));
    await waitFor(() => expect(screen.getByText(/not connected/)).toBeTruthy());
  });

  it("says a restart is needed only when an engine is already running", async () => {
    vi.spyOn(api, "getSetup").mockResolvedValue(report({ wired: true, ready: true, checks: [] }));
    vi.spyOn(api, "putIntegrations").mockResolvedValue({ projectRepos: {} });
    render(<SettingsDialog onClose={() => {}} />);
    await userEvent.click(await screen.findByRole("button", { name: /save/i }));
    await waitFor(() => expect(screen.getByText(/restart/i)).toBeTruthy());
  });

  it("omits rebase from the merge methods for bitbucket", async () => {
    vi.spyOn(api, "getSetup").mockResolvedValue(report({ checks: [{ id: "forge", state: "ok", detail: "Forge: bitbucket.", blocks: true }] }));
    render(<SettingsDialog onClose={() => {}} />);
    await screen.findByText(/Forge: bitbucket/);
    expect(screen.queryByText(/rebase/i)).toBeNull();
  });
});
