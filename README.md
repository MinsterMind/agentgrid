# AgentGrid

A local dashboard for running a roster of Claude Code agents in parallel. Each tile is a persona (role × repo); assign work with one keystroke, answer permissions and questions inline, and open the full session in a terminal when you need depth.

## Run
    npm install
    npm run build
    npm run serve          # http://127.0.0.1:4800

Roles live in `~/.agentgrid/roles/*.md` (defaults copied on first run). Data in `~/.agentgrid/`.

Set `AGENTGRID_PORT` to run on a port other than 4800 (e.g. if it's already in use). Set `AGENTGRID_HOME` to store data somewhere other than `~/.agentgrid/`.

## Develop
    npm test                              # unit tests (server + ui)
    npm run test:live -w server           # real SDK integration test (costs cents)
    npm run e2e -w ui                     # Playwright smoke against the fake runner
    AGENTGRID_FAKE=1 npm run serve        # server with a scripted runner (no API calls)
    npm run dev -w ui                     # Vite dev server proxying /api to :4800

Design: `docs/superpowers/specs/2026-09-11-agentgrid-design.md`.
