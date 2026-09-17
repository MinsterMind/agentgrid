import { app, BrowserWindow, Menu, dialog, shell, type MenuItemConstructorOptions } from "electron";
import path from "node:path";
import os from "node:os";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { applyLoginShellEnv } from "./shell-env.js";
import { PrefsStore } from "./prefs.js";
import { startServer, type RunningServer } from "@agentgrid/server/dist/start.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const packaged = app.isPackaged;
/** Bundled assets live in Resources/ when packaged; in the repo during development. */
const resource = (...p: string[]) => packaged ? path.join(process.resourcesPath, ...p) : path.resolve(here, "..", "..", ...p);

let running: RunningServer | null = null;
let win: BrowserWindow | null = null;
const prefs = new PrefsStore(app.getPath("userData"));

async function boot(): Promise<RunningServer> {
  const p = prefs.read();
  return startServer({
    home: process.env.AGENTGRID_HOME ?? p.home ?? path.join(os.homedir(), ".agentgrid"),
    browseRoot: process.env.AGENTGRID_BROWSE_ROOT ?? p.browseRoot ?? os.homedir(),
    port: process.env.AGENTGRID_PORT ? Number(process.env.AGENTGRID_PORT) : 0,
    staticDir: packaged ? resource("ui") : resource("ui", "dist"),
    defaultsDir: packaged ? resource("roles") : resource("server", "roles"),
    log: m => console.log(m),
  });
}

async function restartServer(): Promise<void> {
  await running?.close();
  running = await boot();
  win?.loadURL(running.url);
}

function createWindow(url: string): BrowserWindow {
  const w = new BrowserWindow({
    width: 1440, height: 900, minWidth: 900, minHeight: 600, title: "AgentGrid",
    backgroundColor: "#0f1115", titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
    webPreferences: { contextIsolation: true, sandbox: true },
  });
  w.loadURL(url);
  w.webContents.setWindowOpenHandler(({ url: u }) => { void shell.openExternal(u); return { action: "deny" }; });
  w.on("closed", () => { win = null; });
  return w;
}

async function chooseFolder(title: string, current?: string): Promise<string | undefined> {
  const r = await dialog.showOpenDialog({ title, defaultPath: current, properties: ["openDirectory", "createDirectory"] });
  return r.canceled ? undefined : r.filePaths[0];
}

function buildMenu(): void {
  const settings: MenuItemConstructorOptions = {
    label: "Settings", submenu: [
      { label: "Browse root for Spawn…", click: async () => { const d = await chooseFolder("Folder the Spawn dialog starts in", prefs.read().browseRoot); if (d) { prefs.write({ browseRoot: d }); await restartServer(); } } },
      { label: "Data directory…", click: async () => { const d = await chooseFolder("Where AgentGrid keeps roles, agents and memory", prefs.read().home); if (d) { prefs.write({ home: d }); await restartServer(); } } },
      { type: "separator" },
      { label: "Open data directory", click: () => { if (running) void shell.openPath(running.home); } },
      { label: "Restart server", click: () => void restartServer() },
    ],
  };
  const template: MenuItemConstructorOptions[] = [
    ...(process.platform === "darwin" ? [{ role: "appMenu" as const }] : []),
    { role: "fileMenu" }, { role: "editMenu" }, settings,
    { label: "View", submenu: [{ role: "reload" }, { role: "toggleDevTools" }, { type: "separator" }, { role: "resetZoom" }, { role: "zoomIn" }, { role: "zoomOut" }, { type: "separator" }, { role: "togglefullscreen" }] },
    { role: "windowMenu" },
    { role: "help", submenu: [{ label: "AgentGrid on GitHub", click: () => void shell.openExternal("https://github.com/MinsterMind/agentgrid") }] },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function checkClaude(): void {
  const found = (process.env.PATH ?? "").split(path.delimiter).some(d => d && existsSync(path.join(d, "claude")));
  if (!found) void dialog.showMessageBox({ type: "warning", title: "Claude Code not found", message: "The `claude` command isn't on your PATH.", detail: "AgentGrid runs agents through the Claude Code CLI. Install it and sign in (https://claude.com/claude-code), then restart AgentGrid." });
}

app.whenReady().then(async () => {
  applyLoginShellEnv();
  buildMenu();
  try {
    running = await boot();
  } catch (err) {
    await dialog.showMessageBox({ type: "error", title: "AgentGrid could not start", message: String((err as Error).message ?? err) });
    app.quit(); return;
  }
  win = createWindow(running.url);
  checkClaude();
  app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0 && running) win = createWindow(running.url); });
});

app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
app.on("before-quit", () => { void running?.close(); });
