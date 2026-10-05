# Pages

Framework: React 19 + Vite (SPA), TypeScript. No component library — all components are custom. CSS: one hand-written vanilla stylesheet (`ui/src/styles.css`), class-based, no Tailwind/CSS modules. Routing: hash-based (`ui/src/hooks/useHashRoute.ts`). Dark-only theme. Desktop app wraps it in Electron.

Shared everywhere (not listed per page): `ui/src/styles.css`, `ui/src/types.ts`, `ui/src/api.ts`.

## Grid (home, `#/`)
Entry: ui/src/App.tsx
Dependencies:
- ui/src/state/reducer.ts
- ui/src/state/sections.ts
- ui/src/components/AgentGrid.tsx
  - ui/src/components/SessionTile.tsx
    - ui/src/format.ts
  - ui/src/components/AgentTile.tsx
    - ui/src/components/AssignBox.tsx
- ui/src/components/SidePanel.tsx
  - ui/src/components/PendingPrompt.tsx
  - ui/src/components/BugPanel.tsx
    - ui/src/bugView.ts
    - ui/src/components/BugGates.tsx
      - ui/src/components/DiffView.tsx
      - ui/src/components/ErrorCard.tsx
      - ui/src/components/Markdown.tsx
      - ui/src/components/PlanView.tsx
- ui/src/components/TopBar.tsx
- ui/src/components/SpawnDialog.tsx
- ui/src/components/BugLauncher.tsx
- ui/src/components/SettingsDialog.tsx
- ui/src/components/SessionsPanel.tsx
- ui/src/components/TranscriptView.tsx
- ui/src/components/BugScreen.tsx
- ui/src/hooks/useHashRoute.ts
- ui/src/hooks/useKeyboard.ts
- ui/src/notify.ts

## Bug screen (`#/bugs/<id>`)
Entry: ui/src/components/BugScreen.tsx
Dependencies:
- ui/src/bugView.ts
- ui/src/format.ts
- ui/src/state/reducer.ts
- ui/src/components/BugGates.tsx
  - ui/src/components/DiffView.tsx
  - ui/src/components/ErrorCard.tsx
  - ui/src/components/Markdown.tsx
  - ui/src/components/PlanView.tsx

## Settings dialog
Entry: ui/src/components/SettingsDialog.tsx
Dependencies:


## Fix a bug launcher
Entry: ui/src/components/BugLauncher.tsx
Dependencies:


## Spawn dialog
Entry: ui/src/components/SpawnDialog.tsx
Dependencies:


## Sessions panel
Entry: ui/src/components/SessionsPanel.tsx
Dependencies:
- ui/src/format.ts
