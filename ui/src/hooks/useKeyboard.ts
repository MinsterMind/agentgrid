import { useEffect } from "react";

export function useKeyboard(h: { select: (i: number) => void; allow: () => void; deny: () => void; open: () => void; escape: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable)) { if (e.key === "Escape") t.blur(); return; }
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key >= "1" && e.key <= "9") h.select(Number(e.key) - 1);
      else if (e.key === "a") h.allow();
      else if (e.key === "d") h.deny();
      else if (e.key === "o") h.open();
      else if (e.key === "Escape") h.escape();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [h]);
}
