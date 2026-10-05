import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TopBar } from "../src/components/TopBar";

const counts = { free: 1, working: 2, waiting: 1, done: 1, failed: 1 };
const props = (over = {}) => ({ counts, spend: 4.12, connected: true, waitingCount: 1, bugsWaiting: 1, view: "grid" as const,
  onView: vi.fn(), onCycleWaiting: vi.fn(), onSpawn: vi.fn(), onSessions: vi.fn(), onFixBug: vi.fn(), onOpenSettings: vi.fn(), ...over });

describe("TopBar", () => {
  it("shows live counters as numbers with labels", () => {
    render(<TopBar {...props()} />);
    for (const [label, n] of [["Working", "2"], ["Done", "1"], ["Failed", "1"], ["Today", "$4.12"]]) {
      expect(screen.getByText(label).closest(".counter")).toHaveTextContent(n);
    }
  });

  it("NEEDS YOU is a glowing button that cycles to the next agent", async () => {
    const p = props();
    render(<TopBar {...p} />);
    const needs = screen.getByRole("button", { name: "1 Needs you" });
    expect(needs).toHaveClass("hot");
    await userEvent.click(needs);
    expect(p.onCycleWaiting).toHaveBeenCalled();
  });

  // Review Focus 4
  it("NEEDS YOU at zero neither glows nor clicks", () => {
    render(<TopBar {...props({ waitingCount: 0 })} />);
    const needs = screen.getByRole("button", { name: "0 Needs you" });
    expect(needs).not.toHaveClass("hot");
    expect(needs).toBeDisabled();
  });

  it("switches views with Agents | Bugs, marking the current one", async () => {
    const p = props();
    render(<TopBar {...p} />);
    expect(screen.getByRole("button", { name: "Agents" })).toHaveAttribute("aria-pressed", "true");
    await userEvent.click(screen.getByRole("button", { name: /^Bugs/ }));
    expect(p.onView).toHaveBeenCalledWith("bugs");
  });

  it("badges Bugs with how many wait on you, and hides the badge at zero", () => {
    const { rerender } = render(<TopBar {...props()} />);
    expect(screen.getByRole("button", { name: "Bugs 1 waiting" })).toBeInTheDocument();
    rerender(<TopBar {...props({ bugsWaiting: 0 })} />);
    expect(screen.getByRole("button", { name: "Bugs" })).toBeInTheDocument();
  });

  it("names every action in words", () => {
    render(<TopBar {...props()} />);
    for (const name of ["Fix a bug", "Sessions", "Settings", "New agent"]) expect(screen.getByRole("button", { name })).toBeInTheDocument();
  });

  // Review Focus 5
  it("says when the server is disconnected", () => {
    render(<TopBar {...props({ connected: false })} />);
    expect(screen.getByText("Disconnected")).toBeInTheDocument();
  });
});
