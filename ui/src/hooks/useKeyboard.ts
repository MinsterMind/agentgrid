import { useEffect } from "react";

export function useKeyboard(h: { select: (i: number) => void; allow: () => void; deny: () => void; open: () => void; escape: () => void; newAgent: () => void; fixBug: () => void; sessions: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable)) { if (e.key === "Escape") t.blur(); return; }
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      // With a dialog open, the grid's single-key shortcuts would act behind it (or stack a second
      // dialog on top). Only Escape — which closes it — gets through.
      if (e.key !== "Escape" && document.querySelector(".modal")) return;
      if (e.key >= "1" && e.key <= "9") h.select(Number(e.key) - 1);
      else if (e.key === "a") h.allow();
      else if (e.key === "d") h.deny();
      else if (e.key === "o") h.open();
      else if (e.key === "n") h.newAgent();
      else if (e.key === "b") h.fixBug();
      else if (e.key === "s") h.sessions();
      else if (e.key === "Escape") h.escape();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [h]);
}
