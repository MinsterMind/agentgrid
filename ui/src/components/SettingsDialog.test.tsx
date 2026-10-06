import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SettingsDialog } from "./SettingsDialog";
import { api } from "../api";

const ADD_COMMAND = "claude mcp add --transport http atlassian https://mcp.atlassian.com/v1/mcp";
// The `fix` on the tracker check is what the server really sends in the nothing-discovered case
// (`setup.ts`: `fix: { kind: "command", value: DEFAULT_ADD_COMMAND }`). Omitting it here is how
// M4's duplicate add-command row survived review — the fixture rendered only one of the two.
const report = (over: Partial<import("../types").SetupReport> = {}): import("../types").SetupReport => ({
  ready: false, wired: false, addCommand: ADD_COMMAND,
  checks: [{ id: "tracker", state: "missing", detail: "No tracker configured.", blocks: true,
             fix: { kind: "command", value: ADD_COMMAND } }],
  discovery: { servers: [], problems: [] }, ...over,
});

beforeEach(() => vi.restoreAllMocks());

describe("SettingsDialog", () => {
  it("lists every server Claude Code knows, with where it came from", async () => {
    vi.spyOn(api, "getSetup").mockResolvedValue(report({ discovery: { problems: [], servers: [
      { name: "claude.ai Atlassian", toolPrefix: "mcp__claude_ai_Atlassian", origin: "account" },
      { name: "jira", toolPrefix: "mcp__jira", origin: "project", originDetail: "/Users/x/repo" },
    ] } }));
    render(<SettingsDialog onClose={() => {}} />);
    expect(await screen.findByText(/claude\.ai Atlassian/)).toBeTruthy();
    expect(screen.getByText(/linked to your Claude account/i)).toBeTruthy();
    expect(screen.getByText(/\/Users\/x\/repo/)).toBeTruthy();
  });

  it("Use this writes only the prefix", async () => {
    vi.spyOn(api, "getSetup").mockResolvedValue(report({ discovery: { problems: [], servers: [
      { name: "claude.ai Atlassian", toolPrefix: "mcp__claude_ai_Atlassian", origin: "account" },
    ] } }));
    vi.spyOn(api, "getIntegrations").mockResolvedValue({ projectRepos: {} });
    const put = vi.spyOn(api, "putIntegrations").mockResolvedValue({ projectRepos: {} });
    render(<SettingsDialog onClose={() => {}} />);
    // "Use this" waits for the saved config: it has to re-send `hints` and the saved preset,
    // and it cannot preserve what it has not been told (I3).
    await waitFor(() => expect((screen.getByRole("button", { name: /use this/i }) as HTMLButtonElement).disabled).toBe(false));
    await userEvent.click(screen.getByRole("button", { name: /use this/i }));
    expect(put).toHaveBeenCalledWith(expect.objectContaining({
      tracker: expect.objectContaining({ toolPrefix: "mcp__claude_ai_Atlassian" }),
    }));
    const sent = put.mock.calls[0][0] as any;
    expect(sent.tracker.mcpServers).toBeUndefined();
  });

  // M4: the check's own `fix` already renders the command with a Copy button, so the dialog
  // must not render a second copy of it beside the list.
  it("shows the add command exactly once when Claude Code has nothing", async () => {
    vi.spyOn(api, "getSetup").mockResolvedValue(report({ discovery: { servers: [], problems: [] } }));
    render(<SettingsDialog onClose={() => {}} />);
    expect(await screen.findByText(/^claude mcp add --transport http/)).toBeTruthy();
    expect(screen.getAllByText(/^claude mcp add --transport http/)).toHaveLength(1);
  });

  // M5: `action` is a server vocabulary the UI used to drop on the floor — `Fix` rendered
  // `command`/`env`/`field` and returned null for everything else, so a check whose only remedy
  // is "press a button here" showed no remedy at all.
  it("renders an action fix rather than dropping it", async () => {
    vi.spyOn(api, "getSetup").mockResolvedValue(report({
      checks: [{ id: "config-file", state: "missing", blocks: true,
                 detail: "~/.agentgrid/integrations.json does not exist yet. Saving here creates it.",
                 fix: { kind: "action", value: "save" } }],
    }));
    render(<SettingsDialog onClose={() => {}} />);
    // A function matcher, because the hint emphasises the button name (`<b>Save</b>`) and the
    // default matcher only sees an element's direct text nodes.
    expect(await screen.findByText((_t, el) =>
      el?.className === "hint" && /press save below to create it/i.test(el.textContent ?? ""))).toBeTruthy();
  });

  // I1: a project- or repo-scoped server loads only when Claude Code resolves it relative to the
  // working directory, and AgentGrid's tracker calls run in the directory the *server* was
  // launched from (`tracker.ts`: `cwd: process.cwd()`), never the ticket's repo. The row stays —
  // someone launching from there can use it — but it must not read as "click and you're done".
  it("says a directory-scoped server only resolves when AgentGrid runs from that directory", async () => {
    vi.spyOn(api, "getSetup").mockResolvedValue(report({ discovery: { problems: [], servers: [
      { name: "claude.ai Atlassian", toolPrefix: "mcp__claude_ai_Atlassian", origin: "account" },
      { name: "jira", toolPrefix: "mcp__jira", origin: "project", originDetail: "/Users/x/repo" },
      { name: "repo-jira", toolPrefix: "mcp__repo_jira", origin: "repo", originDetail: "/Users/x/other" },
    ] } }));
    render(<SettingsDialog onClose={() => {}} />);
    expect(await screen.findByText(/\/Users\/x\/repo\b.*only.*running AgentGrid from/i)).toBeTruthy();
    expect(screen.getByText(/\/Users\/x\/other\b.*only.*running AgentGrid from/i)).toBeTruthy();
    // The reachable origins carry no such caveat.
    expect(screen.getByText(/linked to your Claude account/i).textContent).not.toMatch(/running AgentGrid from/i);
  });

  // I3: `hints` is a live TrackerConfig field injected into every tracker prompt, invisible in
  // the UI, and `PUT` replaces `tracker` wholesale — so "Use this" used to destroy a hand-set
  // `hints` and reset a hand-set `preset` to the first option, silently, on one click.
  it("Use this keeps a hand-set preset and hints instead of destroying them", async () => {
    vi.spyOn(api, "getSetup").mockResolvedValue(report({ discovery: { problems: [], servers: [
      { name: "claude.ai Atlassian", toolPrefix: "mcp__claude_ai_Atlassian", origin: "account" },
    ] } }));
    vi.spyOn(api, "getIntegrations").mockResolvedValue({ projectRepos: {},
      tracker: { preset: "linear", toolPrefix: "mcp__old", hints: "Bugs live in PAY" } });
    const put = vi.spyOn(api, "putIntegrations").mockResolvedValue({ projectRepos: {} });
    render(<SettingsDialog onClose={() => {}} />);
    // Wait for the saved tracker to land, or this would assert against the unseeded state.
    await waitFor(() => expect((screen.getAllByRole("combobox")[0] as HTMLSelectElement).value).toBe("linear"));
    await userEvent.click(screen.getByRole("button", { name: /use this/i }));
    await waitFor(() => expect(put).toHaveBeenCalled());
    expect((put.mock.calls[0][0] as { tracker?: unknown }).tracker)
      .toEqual({ preset: "linear", toolPrefix: "mcp__claude_ai_Atlassian", hints: "Bugs live in PAY" });
  });

  it("Use this sends no hints when none is stored", async () => {
    vi.spyOn(api, "getSetup").mockResolvedValue(report({ discovery: { problems: [], servers: [
      { name: "claude.ai Atlassian", toolPrefix: "mcp__claude_ai_Atlassian", origin: "account" },
    ] } }));
    vi.spyOn(api, "getIntegrations").mockResolvedValue({ projectRepos: {} });
    const put = vi.spyOn(api, "putIntegrations").mockResolvedValue({ projectRepos: {} });
    render(<SettingsDialog onClose={() => {}} />);
    await waitFor(() => expect((screen.getByRole("button", { name: /use this/i }) as HTMLButtonElement).disabled).toBe(false));
    await userEvent.click(screen.getByRole("button", { name: /use this/i }));
    await waitFor(() => expect(put).toHaveBeenCalled());
    expect((put.mock.calls[0][0] as { tracker?: unknown }).tracker)
      .toEqual({ preset: "jira", toolPrefix: "mcp__claude_ai_Atlassian" });
  });

  // M7: the hand-entry box is the documented remedy for the deferred Refresh. Opening it and
  // pressing Save with it empty used to throw out of `JSON.parse` and abort the whole save —
  // the forge included — with only a parser message to show for it.
  it("an empty hand-entry box does not abort the save", async () => {
    vi.spyOn(api, "getSetup").mockResolvedValue(report());
    vi.spyOn(api, "getIntegrations").mockResolvedValue({ projectRepos: {} });
    const put = vi.spyOn(api, "putIntegrations").mockResolvedValue({ projectRepos: {} });
    render(<SettingsDialog onClose={() => {}} />);
    await userEvent.click(await screen.findByRole("button", { name: /enter a tracker by hand/i }));
    await userEvent.click(screen.getByRole("button", { name: /^save$/i }));
    await waitFor(() => expect(put).toHaveBeenCalled());
    const sent = put.mock.calls[0][0] as { tracker?: unknown; forge?: unknown };
    expect(sent.tracker).toBeUndefined();
    expect(sent.forge).toEqual({ preset: "github" });
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
    expect(await screen.findByText(/gitlab \(current\)/)).toBeTruthy();

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
    await waitFor(() => expect(screen.getByRole("button", { name: "GitHub" })).toBeTruthy());
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

  it("entering a tracker by hand sends exactly the pasted preset and toolPrefix, no extra keys", async () => {
    vi.spyOn(api, "getSetup").mockResolvedValue(report());
    const put = vi.spyOn(api, "putIntegrations").mockResolvedValue({ projectRepos: {} });
    render(<SettingsDialog onClose={() => {}} />);
    await userEvent.click(await screen.findByRole("button", { name: /enter a tracker by hand/i }));
    const box = await screen.findByPlaceholderText(/toolPrefix/);
    fireEvent.change(box, { target: { value: '{"preset":"jira","toolPrefix":"mcp__x"}' } });
    await userEvent.click(screen.getByRole("button", { name: /save/i }));
    await waitFor(() => expect(put).toHaveBeenCalled());
    const sent = put.mock.calls[0][0] as { tracker?: unknown };
    expect(sent.tracker).toEqual({ preset: "jira", toolPrefix: "mcp__x" });
  });

  it("can be dismissed from the header, without scrolling to the bottom", async () => {
    vi.spyOn(api, "getSetup").mockResolvedValue(report());
    const onClose = vi.fn();
    render(<SettingsDialog onClose={onClose} />);
    await userEvent.click(await screen.findByRole("button", { name: "Close settings" }));
    expect(onClose).toHaveBeenCalled();
  });

  // The sticky-footer CSS targets `.footer` by name, not by position (a positional selector
  // silently stopped matching once a save added a trailing message div — see styles.css). This
  // pins the class stays on the Save/Close row, so a rename can't silently detach the styling.
  it("keeps the Save/Close row tagged as the sticky footer", async () => {
    vi.spyOn(api, "getSetup").mockResolvedValue(report());
    render(<SettingsDialog onClose={() => {}} />);
    const save = await screen.findByRole("button", { name: /^save$/i });
    expect(save.closest(".row")).toHaveClass("footer");
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
  it("warns in the Tracker section when Claude Code does not have the chosen tracker", async () => {
    vi.spyOn(api, "getSetup").mockResolvedValue(report({ checks: [
      { id: "tracker", state: "ok", blocks: true, detail: "Tracker configured (jira, tools mcp__atlassian)." },
      { id: "tracker-server", state: "missing", blocks: false, detail: "Claude Code has no MCP server matching mcp__atlassian." },
    ], discovery: { problems: [], servers: [
      { name: "claude.ai Claude Docs", toolPrefix: "mcp__claude_ai_Claude_Docs", origin: "account" },
    ] } }));
    render(<SettingsDialog onClose={() => {}} />);
    const warning = await screen.findByText(/no MCP server matching mcp__atlassian/);
    expect(warning.closest("section")!.querySelector("h4")!.textContent).toBe("Tracker");
    expect(screen.queryByText("Other problems")).toBeNull();
  });

  it("marks the server the tracker already uses", async () => {
    vi.spyOn(api, "getSetup").mockResolvedValue(report({ checks: [], discovery: { problems: [], servers: [
      { name: "claude.ai Atlassian", toolPrefix: "mcp__claude_ai_Atlassian", origin: "account" },
      { name: "claude.ai Claude Docs", toolPrefix: "mcp__claude_ai_Claude_Docs", origin: "account" },
    ] } }));
    vi.spyOn(api, "getIntegrations").mockResolvedValue({ projectRepos: {},
      tracker: { preset: "jira", toolPrefix: "mcp__claude_ai_Atlassian" } } as never);
    render(<SettingsDialog onClose={() => {}} />);
    const inUse = await screen.findByText(/in use/i);
    expect(inUse.closest(".row")!.textContent).toContain("claude.ai Atlassian");
    expect(screen.getAllByText(/in use/i)).toHaveLength(1);
  });
});

describe("Settings — readiness checklist", () => {
  it("opens with what is left before bug fixes work", async () => {
    vi.spyOn(api, "getSetup").mockResolvedValue(report({ ready: false, checks: [
      { id: "tracker", state: "ok", blocks: true, detail: "Tracker configured (jira, tools mcp__x)." },
      { id: "forge", state: "missing", blocks: true, detail: "No forge configured." },
      { id: "role", state: "ok", blocks: true, detail: "The bugfix role resolves." },
    ] }));
    render(<SettingsDialog onClose={() => {}} />);
    const banner = await screen.findByTestId("overall");
    expect(banner).toHaveTextContent("1 thing left before you can fix bugs");
    expect(banner).toHaveTextContent(/Agents work without any of this/);
    expect(within(banner).getByText("Forge").closest(".chip")).toHaveClass("amber");
  });

  it("says ready when everything blocking is ok", async () => {
    vi.spyOn(api, "getSetup").mockResolvedValue(report({ ready: true, checks: [{ id: "tracker", state: "ok", blocks: true, detail: "ok" }] }));
    render(<SettingsDialog onClose={() => {}} />);
    expect(await screen.findByTestId("overall")).toHaveTextContent("Ready to fix bugs");
  });

  it("explains why each section exists", async () => {
    vi.spyOn(api, "getSetup").mockResolvedValue(report({}));
    render(<SettingsDialog onClose={() => {}} />);
    expect(await screen.findByText(/Where your tickets live/)).toBeInTheDocument();
    expect(screen.getByText(/Where pull requests are opened and merged/)).toBeInTheDocument();
  });

  it("picks the forge with a segmented control", async () => {
    vi.spyOn(api, "getSetup").mockResolvedValue(report({}));
    vi.spyOn(api, "getIntegrations").mockResolvedValue({ projectRepos: {}, forge: { preset: "github" } } as never);
    render(<SettingsDialog onClose={() => {}} />);
    await userEvent.click(await screen.findByRole("button", { name: /bitbucket/i }));
    expect(screen.getByRole("button", { name: /bitbucket/i })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByPlaceholderText("Atlassian account email")).toBeInTheDocument();
  });

describe("Settings — forge toggle (phase 3 M-4)", () => {
  it("clicking the forge already selected changes nothing", async () => {
    vi.spyOn(api, "getSetup").mockResolvedValue(report({ checks: [{ id: "forge", state: "ok", detail: "Forge: github.", blocks: true }] }));
    vi.spyOn(api, "getIntegrations").mockResolvedValue({ projectRepos: {}, forge: { preset: "github" } } as never);
    const put = vi.spyOn(api, "putIntegrations").mockResolvedValue({ projectRepos: {} });
    render(<SettingsDialog onClose={() => {}} />);
    await userEvent.click(await screen.findByRole("button", { name: "GitHub" }));
    await userEvent.click(screen.getByRole("button", { name: /^save$/i }));
    await waitFor(() => expect(put).toHaveBeenCalled());
    expect((put.mock.calls[0][0] as { forge?: unknown }).forge).toBeUndefined();
  });

  it("lets you switch back to a saved forge the toggle cannot offer", async () => {
    vi.spyOn(api, "getSetup").mockResolvedValue(report({ checks: [{ id: "forge", state: "ok", detail: "Forge: gitlab.", blocks: true }] }));
    vi.spyOn(api, "getIntegrations").mockResolvedValue({ projectRepos: {}, forge: { preset: "gitlab", username: "u" } } as never);
    render(<SettingsDialog onClose={() => {}} />);
    await userEvent.click(await screen.findByRole("button", { name: "GitHub" }));
    expect(screen.getByRole("button", { name: /gitlab \(current\)/ })).toHaveAttribute("aria-pressed", "false");
    await userEvent.click(screen.getByRole("button", { name: /gitlab \(current\)/ }));
    expect(screen.getByRole("button", { name: /gitlab \(current\)/ })).toHaveAttribute("aria-pressed", "true");
  });
});

});

describe("SettingsDialog — Always allowed", () => {
  it("lists the shared rules, and removes one", async () => {
    vi.spyOn(api, "getSetup").mockResolvedValue(report());
    vi.spyOn(api, "listRules").mockResolvedValue({ rules: [{ rule: "Bash(npm test:*)", addedAt: new Date(Date.now() - 3 * 3600_000).toISOString() }, { rule: "Edit", addedAt: new Date().toISOString() }], problem: null });
    const remove = vi.spyOn(api, "removeRule").mockResolvedValue({ rules: [{ rule: "Edit", addedAt: new Date().toISOString() }], problem: null });
    render(<SettingsDialog onClose={() => {}} />);
    const sec = (await screen.findByRole("heading", { name: /always allowed/i })).closest("section")!;
    expect(await within(sec as HTMLElement).findByText("Bash(npm test:*)")).toBeTruthy();
    expect(within(sec as HTMLElement).getByText(/for every agent, bug fix and embedded terminal/i)).toBeTruthy();
    await userEvent.click(within(sec as HTMLElement).getByRole("button", { name: "Remove Bash(npm test:*)" }));
    expect(remove).toHaveBeenCalledWith("Bash(npm test:*)");
    await waitFor(() => expect(within(sec as HTMLElement).queryByText("Bash(npm test:*)")).toBeNull());
  });
  it("says how rules get there when there are none, and shows a problem reading the file", async () => {
    vi.spyOn(api, "getSetup").mockResolvedValue(report());
    vi.spyOn(api, "listRules").mockResolvedValue({ rules: [], problem: "permissions.json could not be read" });
    render(<SettingsDialog onClose={() => {}} />);
    expect(await screen.findByText(/Nothing yet — use Always allow on a request to add a rule\./)).toBeTruthy();
    expect(screen.getByText(/permissions\.json could not be read/)).toBeTruthy();
  });
});
