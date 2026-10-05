/** Commands the server's messages carry for the human to run (cleanup hints, mostly): a known
 *  tool at the start of a line or right after a colon, carrying at least one flag. Prose that
 *  merely mentions a tool ("not a git repository", "claude exited with code 1") is not one. */
const COMMAND = /(?:^|:[ \t]+)[ \t]*((?:git|gh|claude|npm) [^\n]*?[ \t]-\S[^\n]*)/gm;

export function splitError(text: string): { headline: string; details: string; commands: string[] } {
  const t = text.trim();
  const [first, ...more] = t.split("\n");
  const cut = first.search(/\.\s/);
  const headline = cut > 0 ? first.slice(0, cut + 1) : first;
  const details = [cut > 0 ? first.slice(cut + 1).trim() : "", ...more].filter(Boolean).join("\n").trim();
  return { headline, details, commands: [...t.matchAll(COMMAND)].map(m => m[1].trim()) };
}

/** A failure as a message: one readable headline, the rest on request, commands one click away. */
export function ErrorCard({ text, title, testId }: { text: string; title?: string; testId?: string }) {
  const { headline, details, commands } = splitError(text);
  return (
    <div className="errcard" role="alert" data-testid={testId}>
      {title && <div className="errcard-title">{title}</div>}
      <div className="errcard-head">{headline}</div>
      {details && <details><summary>Details</summary><pre className="errcard-details">{details}</pre></details>}
      {commands.map(c => (
        <div key={c} className="row">
          <code className="cmd">{c}</code>
          <button type="button" className="btn sm" onClick={() => void navigator.clipboard?.writeText(c)}>Copy</button>
        </div>
      ))}
    </div>
  );
}
