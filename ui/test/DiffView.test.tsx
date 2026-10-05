import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { DiffView } from "../src/components/DiffView";

const PATCH = "diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1,2 +1,2 @@ fn()\n keep\n-old\n+new\n";

describe("DiffView", () => {
  it("renders gutters, tinted rows and a labelled hunk divider, with no patch headers", () => {
    const { container } = render(<DiffView patch={PATCH} />);
    expect(container.querySelector("tr.add td.code")!.textContent).toBe("new");
    expect(container.querySelector("tr.del td.code")!.textContent).toBe("old");
    expect(screen.getByText("fn()")).toBeInTheDocument();
    expect(container.textContent).not.toMatch(/\+\+\+|---|@@/);
    expect(container.querySelector("tr.add td.ln.new")!.textContent).toBe("2");
  });
});
