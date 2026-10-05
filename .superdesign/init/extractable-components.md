# Extractable components

## Layout Components
## TopBar
- Source: `ui/src/components/TopBar.tsx`
- Category: layout
- Description: App header — brand, live agent-state pills, view toggle and primary actions
- Extractable props: waitingCount (number, default: 0), bugsActive (boolean, default: false), connected (boolean, default: true)
- Hardcoded: brand mark, button labels, pill styles

## SidePanel
- Source: `ui/src/components/SidePanel.tsx`
- Category: layout
- Description: Right-hand detail panel for the selected agent
- Extractable props: agentState (string, default: "working")
- Hardcoded: section headings, action labels

## Basic Components
## AgentTile
- Source: `ui/src/components/AgentTile.tsx`
- Category: basic
- Description: Grid card for one agent — avatar ring by state, name, repo, live activity, footer meta
- Extractable props: state (string, default: "working"), selected (boolean, default: false), badgeCount (number, default: 0)
- Hardcoded: layout, ring colors

## SessionTile
- Source: `ui/src/components/SessionTile.tsx`
- Category: basic
- Description: Card for an unclaimed live Claude Code session that can be pulled in
- Extractable props: status (string, default: "busy")
- Hardcoded: action labels

## ErrorCard
- Source: `ui/src/components/ErrorCard.tsx`
- Category: basic
- Description: Error message card — headline, collapsible details, copyable commands
- Extractable props: showTitle (boolean, default: false)
- Hardcoded: styles

## PipelineStep (inline in BugScreen)
- Source: `ui/src/components/BugScreen.tsx`
- Category: basic
- Description: One step pill in the bug pipeline strip (icon + label + state word)
- Extractable props: state (string, default: "current")
- Hardcoded: icons per state
