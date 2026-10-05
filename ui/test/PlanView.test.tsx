import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { PlanView } from "../src/components/PlanView";

const PLAN = "# Plan\n\n## Root cause\nThe **token** rotates twice.\n\n## Fix\n- `src/auth/session.ts`: rotate once\n\n## Test strategy\nA unit test.\n\n## Risks and anything you are unsure about\nNone.";

describe("PlanView", () => {
  it("shows each section as its own titled block with no markdown syntax", () => {
    const { container } = render(<PlanView markdown={PLAN} />);
    for (const t of ["Root cause", "Fix", "Test strategy", "Risks and anything you are unsure about"]) expect(screen.getByRole("heading", { name: t })).toBeInTheDocument();
    expect(container.textContent).not.toMatch(/##|\*\*|`/);
  });
  it("links a file named in the plan to the diff when that file changed", async () => {
    const onOpenFile = vi.fn();
    render(<PlanView markdown={PLAN} files={["src/auth/session.ts"]} onOpenFile={onOpenFile} />);
    await userEvent.click(screen.getByRole("button", { name: "src/auth/session.ts" }));
    expect(onOpenFile).toHaveBeenCalledWith("src/auth/session.ts");
  });
  it("renders a plan without the usual headings whole, with a quiet note", () => {
    const { container } = render(<PlanView markdown={"**Root cause**\nA"} />);
    expect(screen.getByText(/doesn't follow the usual sections/i)).toBeInTheDocument();
    expect(container.querySelector("strong")!.textContent).toBe("Root cause");
  });
});
