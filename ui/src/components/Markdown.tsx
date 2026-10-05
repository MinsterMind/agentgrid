import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

/**
 * The one way agent, ticket and forge text reaches the screen. Rendering, never execution:
 * raw HTML is skipped (no rehype-raw), images are not fetched (a tracking pixel in a ticket
 * would otherwise phone home from the operator's machine), and react-markdown's default URL
 * transform already neutralises `javascript:` links.
 */
export function Markdown({ text, inline, fileLinks }: {
  text: string; inline?: boolean; fileLinks?: { files: string[]; onOpen: (path: string) => void };
}) {
  const components: Components = {
    a: ({ href, children }) => <a href={href} target="_blank" rel="noreferrer">{children}</a>,
    img: ({ src, alt }) => <a href={typeof src === "string" ? src : undefined} target="_blank" rel="noreferrer">{alt || src}</a>,
    code: ({ children, className }) => {
      const s = String(children);
      if (!className && fileLinks?.files.includes(s)) {
        return <button type="button" className="filelink" onClick={() => fileLinks.onOpen(s)}>{s}</button>;
      }
      return <code className={className}>{children}</code>;
    },
    ...(inline ? { p: ({ children }) => <>{children}</> } : {}),
  };
  const Tag = inline ? "span" : "div";
  return <Tag className={inline ? "md md-inline" : "md"}><ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml components={components}>{text}</ReactMarkdown></Tag>;
}
