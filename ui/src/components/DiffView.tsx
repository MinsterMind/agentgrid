import { parseHunks } from "../bugView";

/**
 * Per-file slice of a unified diff, so each file can be expanded on its own. (Moved here from
 * BugPanel unchanged.) When the split can't isolate this file (a rename, or a header format that
 * doesn't literally name every path in `files[]`), fall back to the whole patch — flagged as
 * unisolated so the card never presents unrelated content as this file's diff.
 */
export function hunksFor(patch: string, file: string): { text: string; isolated: boolean } {
  const parts = patch.split(/^diff --git /m).slice(1);
  const hit = parts.find(p => p.split("\n")[0].trimEnd() === `a/${file} b/${file}`);
  return hit ? { text: `diff --git ${hit}`.trimEnd(), isolated: true } : { text: patch, isolated: false };
}

/** A patch as a diff: gutters, tinted rows, hunk dividers. No syntax highlighting (spec §10). */
export function DiffView({ patch }: { patch: string }) {
  const rows = parseHunks(patch);
  const multiFile = rows.filter(r => r.kind === "file").length > 1;
  return (
    <table className="diffview"><tbody>
      {rows.map((r, i) => {
        if (r.kind === "file") return multiFile ? <tr key={i} className="file"><td colSpan={3}>{r.text}</td></tr> : null;
        if (r.kind === "hunk") return <tr key={i} className="hunk"><td colSpan={3}>{r.context || " "}</td></tr>;
        if (r.kind === "note") return <tr key={i} className="note"><td colSpan={3}>{r.text}</td></tr>;
        return (
          <tr key={i} className={r.kind}>
            <td className="ln old">{r.oldNo ?? ""}</td>
            <td className="ln new">{r.newNo ?? ""}</td>
            <td className="code">{r.text}</td>
          </tr>
        );
      })}
    </tbody></table>
  );
}
