import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ErrorCard, splitError } from "../src/components/ErrorCard";

const CLEANUP = "worktree removal failed: busy. Left behind: /r/.worktrees/bugfix-PAY-1 and branch bugfix/PAY-1 — clear them with: git -C /r worktree remove --force /r/.worktrees/bugfix-PAY-1 && git -C /r branch -D bugfix/PAY-1";

describe("splitError", () => {
  it("uses the first sentence as the headline and keeps the rest as details", () => {
    const r = splitError(CLEANUP);
    expect(r.headline).toBe("worktree removal failed: busy.");
    expect(r.details).toMatch(/^Left behind/);
  });
  it("uses the first line when there is no sentence break", () => {
    expect(splitError("no commits on the task branch\nmore")).toMatchObject({ headline: "no commits on the task branch", details: "more" });
  });
  it("finds the commands to copy", () => {
    expect(splitError(CLEANUP).commands).toEqual(["git -C /r worktree remove --force /r/.worktrees/bugfix-PAY-1 && git -C /r branch -D bugfix/PAY-1"]);
  });
  it("a one-liner has no details", () => {
    expect(splitError("boom")).toEqual({ headline: "boom", details: "", commands: [] });
  });
});

describe("ErrorCard", () => {
  it("shows the headline, hides details behind a disclosure, and copies a command", async () => {
    const writeText = vi.fn(async () => {});
    Object.assign(navigator, { clipboard: { writeText } });
    const { container } = render(<ErrorCard title="Merged, with leftovers" text={CLEANUP} />);
    expect(screen.getByText("Merged, with leftovers")).toBeInTheDocument();
    expect(screen.getByText("worktree removal failed: busy.")).toBeInTheDocument();
    expect(container.querySelector("details")!.open).toBe(false);
    await userEvent.click(screen.getByRole("button", { name: /copy/i }));
    expect(writeText).toHaveBeenCalledWith(expect.stringMatching(/^git -C \/r worktree remove/));
  });
describe("splitError command finding", () => {
  it("does not offer prose as a command", () => {
    expect(splitError("fatal: not a git repository (or any of the parent directories)").commands).toEqual([]);
    expect(splitError("claude exited with code 1").commands).toEqual([]);
  });
  it("still finds a command at the start of a line", () => {
    expect(splitError("cleanup incomplete\n  git -C /r branch -D bugfix/X").commands).toEqual(["git -C /r branch -D bugfix/X"]);
  });
});
});
