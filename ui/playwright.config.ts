import { defineConfig } from "@playwright/test";
import { execFileSync } from "node:child_process";
import path from "node:path";

// The bug-fix e2e needs a real repo with a real `origin` remote, because intake refuses one
// without. Build it here rather than asking whoever runs the suite to set an env var — a test
// that only works with hidden setup is a test that quietly stops running.
const fixtureRepo = execFileSync("sh", [path.resolve("e2e/fixture-repo.sh")], { encoding: "utf8" }).trim();
process.env.AGENTGRID_E2E_REPO = process.env.AGENTGRID_E2E_REPO ?? fixtureRepo;

// The same two-step story the offline integration test (`server/test/bugfix/flow.test.ts`)
// scripts the fake forge with: a review lands (opening a feedback round), then, once that
// round is approved and pushed, the approval lands (opening the merge gate). See that file's
// comments for why the call counts (`after: 2`, `after: 5`) are what they are — the watcher's
// own polling, and the engine's own push-confirmation read, both consume `getPr` calls too.
const fakePrScript = JSON.stringify([
  { after: 2, pr: { reviewDecision: "CHANGES_REQUESTED", lastSeenEventAt: "2099-09-26T09:30:00Z" },
    events: [{ kind: "review", state: "CHANGES_REQUESTED", author: "alice", isBot: false, body: "Name it properly.", at: "2099-09-26T09:30:00Z" }] },
  { after: 5, pr: { reviewDecision: "APPROVED", lastSeenEventAt: "2099-09-26T10:00:00Z" } },
]);

// I8, spec §9 ("Nothing in CI reads a real `~/.claude`"): `BugLauncher` calls `GET /api/setup` on
// mount, and this suite clicks "Fix a bug", so the MCP scan runs for real. `start.ts` passes no
// `setupHome`, so `discoverMcpServers` falls back to `os.homedir()` — which on POSIX is `$HOME`.
// `AGENTGRID_HOME` only moves `~/.agentgrid`, so without this the scan would read whatever the
// machine running the suite has in its real `~/.claude`, and the e2e would pass or fail for
// reasons nobody changed. Point HOME at an empty directory: nothing to discover, by construction.
// The assignment applies only to `npm run serve`, so `npm run build` above keeps the real HOME
// (and so its npm cache).
export default defineConfig({
  testDir: "e2e", timeout: 60_000,
  use: { baseURL: "http://127.0.0.1:4811", headless: true },
  webServer: {
    command: `cd .. && npm run build -w ui && HOME=$(mktemp -d) AGENTGRID_FAKE=1 AGENTGRID_PORT=4811 AGENTGRID_HOME=$(mktemp -d) AGENTGRID_BROWSE_ROOT=$(R=$(mktemp -d) && mkdir -p $R/myrepo/.git $R/plain && echo $R) AGENTGRID_FAKE_PR_SCRIPT='${fakePrScript}' npm run serve -w server`,
    url: "http://127.0.0.1:4811/api/state", reuseExistingServer: false, timeout: 120_000,
  },
});
