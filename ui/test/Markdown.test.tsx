import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Markdown } from "../src/components/Markdown";

describe("Markdown", () => {
  it("renders headings, emphasis and code as elements, with no markdown syntax left", () => {
    const { container } = render(<Markdown text={"## Root cause\nThe **token** is `rotated` twice."} />);
    expect(screen.getByRole("heading", { name: "Root cause" })).toBeInTheDocument();
    expect(container.querySelector("strong")!.textContent).toBe("token");
    expect(container.querySelector("code")!.textContent).toBe("rotated");
    expect(container.textContent).not.toMatch(/##|\*\*|`/);
  });

  it("renders a GFM table and a task list", () => {
    const { container } = render(<Markdown text={"| a | b |\n|---|---|\n| 1 | 2 |\n\n- [x] done\n- [ ] todo"} />);
    expect(container.querySelector("table")).not.toBeNull();
    expect(container.querySelectorAll('input[type="checkbox"]')).toHaveLength(2);
  });

  it("never creates elements from raw HTML in the text", () => {
    const { container } = render(<Markdown text={'<script>window.x=1</script><img src=x onerror="window.y=1"> <b>bold</b>'} />);
    expect(container.querySelector("script")).toBeNull();
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("b")).toBeNull();
  });

  it("does not load images; shows their alt text as a link", () => {
    const { container } = render(<Markdown text={"![diagram](https://x/d.png)"} />);
    expect(container.querySelector("img")).toBeNull();
    expect(screen.getByRole("link", { name: "diagram" })).toHaveAttribute("href", "https://x/d.png");
  });

  it("opens links in a new tab without a referrer and drops javascript: urls", () => {
    render(<Markdown text={"[ok](https://x/y) [bad](javascript:alert(1))"} />);
    const ok = screen.getByRole("link", { name: "ok" });
    expect(ok).toHaveAttribute("target", "_blank");
    expect(ok).toHaveAttribute("rel", "noreferrer");
    expect(screen.queryByRole("link", { name: "bad" })?.getAttribute("href") ?? "").not.toMatch(/javascript/);
  });

  it("inline mode renders no paragraph wrapper", () => {
    const { container } = render(<Markdown inline text={"a **b**"} />);
    expect(container.querySelector("p")).toBeNull();
    expect(container.querySelector("strong")).not.toBeNull();
  });

  it("turns inline code naming a known file into a button that opens it", async () => {
    const onOpen = vi.fn();
    render(<Markdown text={"Change `src/a.ts` and `other`."} fileLinks={{ files: ["src/a.ts"], onOpen }} />);
    await userEvent.click(screen.getByRole("button", { name: "src/a.ts" }));
    expect(onOpen).toHaveBeenCalledWith("src/a.ts");
    expect(screen.queryByRole("button", { name: "other" })).toBeNull();
  });
describe("inline Markdown", () => {
  it("keeps block markup out of an inline run", () => {
    const { container } = render(<Markdown inline text={"# Head\n\n- a\n- b\n\n**bold**"} />);
    for (const tag of ["h1", "ul", "li", "p", "pre"]) expect(container.querySelector(tag)).toBeNull();
    expect(container.querySelector("strong")!.textContent).toBe("bold");
    expect(container.textContent).toContain("Head");
  });
});
});
