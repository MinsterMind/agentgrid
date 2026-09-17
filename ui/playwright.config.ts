import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "e2e", timeout: 30_000,
  use: { baseURL: "http://127.0.0.1:4811", headless: true },
  webServer: {
    command: "cd .. && npm run build -w ui && AGENTGRID_FAKE=1 AGENTGRID_PORT=4811 AGENTGRID_HOME=$(mktemp -d) AGENTGRID_BROWSE_ROOT=$(R=$(mktemp -d) && mkdir -p $R/myrepo/.git $R/plain && echo $R) npm run serve -w server",
    url: "http://127.0.0.1:4811/api/state", reuseExistingServer: false, timeout: 120_000,
  },
});
