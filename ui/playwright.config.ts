import { defineConfig } from "@playwright/test";
import { execFileSync } from "node:child_process";
import path from "node:path";

// The bug-fix e2e needs a real repo with a real `origin` remote, because intake refuses one
// without. Build it here rather than asking whoever runs the suite to set an env var — a test
// that only works with hidden setup is a test that quietly stops running.
const fixtureRepo = execFileSync("sh", [path.resolve("e2e/fixture-repo.sh")], { encoding: "utf8" }).trim();
process.env.AGENTGRID_E2E_REPO = process.env.AGENTGRID_E2E_REPO ?? fixtureRepo;

export default defineConfig({
  testDir: "e2e", timeout: 60_000,
  use: { baseURL: "http://127.0.0.1:4811", headless: true },
  webServer: {
    command: "cd .. && npm run build -w ui && AGENTGRID_FAKE=1 AGENTGRID_PORT=4811 AGENTGRID_HOME=$(mktemp -d) AGENTGRID_BROWSE_ROOT=$(R=$(mktemp -d) && mkdir -p $R/myrepo/.git $R/plain && echo $R) npm run serve -w server",
    url: "http://127.0.0.1:4811/api/state", reuseExistingServer: false, timeout: 120_000,
  },
});
