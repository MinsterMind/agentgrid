export const settings = {
  get notifyWaiting() { try { return localStorage.getItem("ag.notifyWaiting") !== "0"; } catch { return true; } },
  set notifyWaiting(v: boolean) { try { localStorage.setItem("ag.notifyWaiting", v ? "1" : "0"); } catch {} },
  get notifyFinished() { try { return localStorage.getItem("ag.notifyFinished") === "1"; } catch { return false; } },
  set notifyFinished(v: boolean) { try { localStorage.setItem("ag.notifyFinished", v ? "1" : "0"); } catch {} },
};

export function setTitleCount(n: number) { document.title = n > 0 ? `(${n}) AgentGrid` : "AgentGrid"; }

function beep() {
  try { const ctx = new AudioContext(); const o = ctx.createOscillator(); const g = ctx.createGain();
    o.frequency.value = 880; g.gain.value = 0.05; o.connect(g); g.connect(ctx.destination); o.start(); o.stop(ctx.currentTime + 0.12); } catch {}
}

async function push(title: string, body: string) {
  if (!("Notification" in window)) return;
  if (Notification.permission === "default") await Notification.requestPermission();
  if (Notification.permission === "granted") new Notification(title, { body });
}

export function notifyWaiting(agentName: string, text: string) { if (!settings.notifyWaiting) return; beep(); void push(`${agentName} needs you`, text); }
export function notifyFinished(agentName: string, ok: boolean) { if (!settings.notifyFinished) return; void push(`${agentName} ${ok ? "finished" : "failed"}`, ""); }
