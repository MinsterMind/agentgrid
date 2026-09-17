import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";

/** Builds the PTY WebSocket URL for a session (same host as the page). */
export const ptyUrl = (sessionId: string, cols: number, rows: number, loc: { protocol: string; host: string } = window.location) =>
  `${loc.protocol === "https:" ? "wss" : "ws"}://${loc.host}/api/pty/${encodeURIComponent(sessionId)}?cols=${cols}&rows=${rows}`;

/**
 * A live Claude Code terminal for one session: xterm.js in the browser, node-pty on the server.
 * Closing the pane detaches (the session keeps running); the ✕ kill button ends it.
 */
export function TerminalPane({ sessionId, onStatus }: { sessionId: string; onStatus?: (s: string) => void }) {
  const host = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState("connecting…");
  const wsRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    if (!host.current) return;
    const term = new Terminal({ cursorBlink: true, fontSize: 12.5, fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", theme: { background: "#0f1115" }, scrollback: 5000, allowProposedApi: true });
    const fit = new FitAddon(); term.loadAddon(fit);
    term.open(host.current); fit.fit();
    const ws = new WebSocket(ptyUrl(sessionId, term.cols, term.rows));
    ws.binaryType = "arraybuffer"; wsRef.current = ws;
    const set = (s: string) => { setStatus(s); onStatus?.(s); };
    ws.onopen = () => { set("live"); term.focus(); };
    ws.onmessage = ev => term.write(typeof ev.data === "string" ? ev.data : new Uint8Array(ev.data));
    ws.onclose = ev => { set(ev.reason || (ev.code === 1000 ? "closed" : `disconnected (${ev.code})`)); term.write(`\r\n\x1b[2m[${ev.reason || "connection closed"}]\x1b[0m\r\n`); };
    ws.onerror = () => set("connection error");
    const enc = new TextEncoder();
    const onData = term.onData(d => { if (ws.readyState === WebSocket.OPEN) ws.send(enc.encode(d)); });
    const onResize = term.onResize(({ cols, rows }) => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "resize", cols, rows })); });
    const ro = new ResizeObserver(() => { try { fit.fit(); } catch { /* not attached */ } });
    ro.observe(host.current);
    return () => { ro.disconnect(); onData.dispose(); onResize.dispose(); ws.close(); term.dispose(); };
  }, [sessionId]);

  const kill = () => { const ws = wsRef.current; if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "kill" })); };

  return (
    <div className="termpane" data-testid="terminal-pane">
      <div className="termbar"><span className={`dim st-${status === "live" ? "live" : "off"}`}>● {status}</span><span className="dim" style={{ marginLeft: 8 }}>session {sessionId.slice(0, 8)}…</span>
        <button className="btn sm d" style={{ marginLeft: "auto" }} title="End this Claude process" onClick={kill}>✕ kill</button></div>
      <div className="termhost" ref={host} />
    </div>
  );
}
