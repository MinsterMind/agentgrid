import { planSections } from "../bugView";
import { Markdown } from "./Markdown";

/** The analyze stage's plan as the four blocks it is asked to have, rather than one document. */
export function PlanView({ markdown, files, onOpenFile }: { markdown: string; files?: string[]; onOpenFile?: (path: string) => void }) {
  const { sections, structured } = planSections(markdown);
  const fileLinks = files && onOpenFile ? { files, onOpen: onOpenFile } : undefined;
  return (
    <div className={`plan ${structured ? "structured" : "whole"}`}>
      {!structured && <p className="hint">This plan doesn't follow the usual sections.</p>}
      {sections.map((s, i) => (
        <section key={i} className="plansec">
          {s.title && <h5>{s.title}</h5>}
          <Markdown text={s.body} fileLinks={fileLinks} />
        </section>
      ))}
    </div>
  );
}
