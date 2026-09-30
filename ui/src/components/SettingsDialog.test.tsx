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
    // Distinct before/after values: if `save()` ever read `wired` from the *refreshed*
    // report instead of the one captured before the request, this would say "live" instead —
    // the assertion below would fail, not just pass by coincidence.
    vi.spyOn(api, "getSetup")
      .mockResolvedValueOnce(report({ wired: true, ready: true, checks: [] }))   // before the save: already wired
      .mockResolvedValue(report({ wired: false, ready: true, checks: [] }));     // after: (hypothetically) not wired
    vi.spyOn(api, "putIntegrations").mockResolvedValue({ projectRepos: {} });
    render(<SettingsDialog onClose={() => {}} />);
    await userEvent.click(await screen.findByRole("button", { name: /save/i }));
    await waitFor(() => expect(screen.getByText(/restart/i)).toBeTruthy());
    expect(screen.queryByText(/now available/i)).toBeNull();
  });

  it("says the workflow is live when the save is what wired it", async () => {
    vi.spyOn(api, "getSetup")
      .mockResolvedValueOnce(report({ wired: false }))                                    // before the save: nothing wired yet
      .mockResolvedValue(report({ wired: true, ready: true, checks: [] }));                // after: this save wired it
    vi.spyOn(api, "putIntegrations").mockResolvedValue({ projectRepos: {} });
    render(<SettingsDialog onClose={() => {}} />);
    await userEvent.click(await screen.findByRole("button", { name: /save/i }));
    await waitFor(() => expect(screen.getByText(/now available/i)).toBeTruthy());
    expect(screen.queryByText(/restart/i)).toBeNull();
  });

  // The saved forge now comes from `GET /api/integrations`, not from parsing the "forge"
  // check's prose (I2) — so this pins the preset through the config, which is what actually
  // decides which merge methods the adapter supports.
  it("omits rebase from the merge methods for bitbucket", async () => {
    vi.spyOn(api, "getSetup").mockResolvedValue(report({ checks: [{ id: "forge", state: "ok", detail: "Forge: bitbucket.", blocks: true }] }));
    vi.spyOn(api, "getIntegrations").mockResolvedValue({ projectRepos: {}, forge: { preset: "bitbucket", username: "me@example.com" } });
    render(<SettingsDialog onClose={() => {}} />);
    await screen.findByText(/Forge: bitbucket/);
    await waitFor(() => expect(screen.queryByText(/rebase/i)).toBeNull());
  });

  // I2: a gitlab or custom forge is a valid `FORGE_PRESETS` value that the select cannot offer.
  // Opening Settings and pressing Save for an unrelated reason (pasting a tracker definition,
  // say) must not rewrite it to github. The old code inferred the preset by regex over the
  // "forge" check's prose and fell back to "github", then sent `forge` on every Save.
  it("does not rewrite a gitlab forge when Save is pressed without touching the forge", async () => {
    vi.spyOn(api, "getSetup").mockResolvedValue(report({
      checks: [{ id: "forge", state: "ok", detail: "Forge: gitlab.", blocks: true }],
    }));
    vi.spyOn(api, "getIntegrations").mockResolvedValue({ projectRepos: {}, forge: { preset: "gitlab", username: "someone" } });
    const put = vi.spyOn(api, "putIntegrations").mockResolvedValue({ projectRepos: {} });
    render(<SettingsDialog onClose={() => {}} />);
    // Wait for the saved forge to land, or the "nothing saved yet" branch would legitimately
    // send one and this would assert against the wrong state.
    expect(await screen.findByText(/gitlab \(saved\)/)).toBeTruthy();

    await userEvent.click(screen.getByRole("button", { name: /save/i }));

    await waitFor(() => expect(put).toHaveBeenCalled());
    const body = put.mock.calls[0][0] as { forge?: { preset?: string } };
    // Either shape is correct: say nothing about the forge, or preserve it exactly. What must
    // never happen is `forge: { preset: "github" }`, which also drops `username`.
    if (body.forge) expect(body.forge.preset).toBe("gitlab");
    else expect(body.forge).toBeUndefined();
  });

  // The companion to the above: a bitbucket user who edits nothing must keep their username,
  // and a fresh machine with no forge saved must still be able to create one.
  it("still sends a forge on a machine that has none saved yet", async () => {
    vi.spyOn(api, "getSetup").mockResolvedValue(report());
    vi.spyOn(api, "getIntegrations").mockResolvedValue({ projectRepos: {} });
    const put = vi.spyOn(api, "putIntegrations").mockResolvedValue({ projectRepos: {} });
    render(<SettingsDialog onClose={() => {}} />);
    await waitFor(() => expect(screen.getByRole("combobox")).toBeTruthy());
    await userEvent.click(screen.getByRole("button", { name: /save/i }));
    await waitFor(() => expect(put).toHaveBeenCalled());
    expect((put.mock.calls[0][0] as { forge?: { preset?: string } }).forge).toEqual({ preset: "github" });
  });

  it("re-sends a saved bitbucket username the user never touched", async () => {
    vi.spyOn(api, "getSetup").mockResolvedValue(report({
      checks: [{ id: "forge", state: "ok", detail: "Forge: bitbucket.", blocks: true }],
    }));
    vi.spyOn(api, "getIntegrations").mockResolvedValue({ projectRepos: {}, forge: { preset: "bitbucket", username: "me@example.com" } });
    const put = vi.spyOn(api, "putIntegrations").mockResolvedValue({ projectRepos: {} });
    render(<SettingsDialog onClose={() => {}} />);
    // The input is seeded from the saved config, not left empty.
    await waitFor(() => expect((screen.getByPlaceholderText(/Atlassian account email/) as HTMLInputElement).value).toBe("me@example.com"));

    await userEvent.click(screen.getByRole("button", { name: /save/i }));
    await waitFor(() => expect(put).toHaveBeenCalled());
    const body = put.mock.calls[0][0] as { forge?: { preset?: string; username?: string } };
    if (body.forge) expect(body.forge).toEqual({ preset: "bitbucket", username: "me@example.com" });
    else expect(body.forge).toBeUndefined();
  });

  it("surfaces a blocking check that has no dedicated section, e.g. a corrupt config file", async () => {
    vi.spyOn(api, "getSetup").mockResolvedValue(report({
      checks: [
        { id: "config-file", state: "broken", blocks: true,
          detail: "~/.agentgrid/integrations.json could not be read: Unexpected token } in JSON at position 42" },
        { id: "tracker", state: "missing", detail: "No tracker configured.", blocks: true },
      ],
    }));
    render(<SettingsDialog onClose={() => {}} />);
    expect(await screen.findByText(/could not be read/)).toBeTruthy();
  });
});
