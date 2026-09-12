import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { PendingPrompt } from "../src/components/PendingPrompt";
import type { Pending } from "../src/types";

const perm = (suggestions: unknown[] = []): Pending => ({ kind: "permission", toolUseId: "t1", toolName: "Bash", input: { command: "kubectl rollout restart deploy/api" }, suggestions });
const q = (multi = false, n = 1): Pending => ({ kind: "question", toolUseId: "t2", toolName: "AskUserQuestion", suggestions: [], input: { questions: Array.from({ length: n }, (_, i) => ({
  question: `Q${i + 1}?`, header: `H${i + 1}`, multiSelect: multi, options: [{ label: "main", description: "d1" }, { label: "develop", description: "d2" }] })) } });

describe("PendingPrompt permission", () => {
  it("shows command and Allow/Deny; Always only with suggestions", async () => {
    const onDecide = vi.fn();
    const { rerender } = render(<PendingPrompt pending={perm()} onDecide={onDecide} />);
    expect(screen.getByText(/kubectl rollout restart/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /always/i })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: /^allow$/i }));
    expect(onDecide).toHaveBeenCalledWith({ kind: "allow" });
    rerender(<PendingPrompt pending={perm([{ type: "addRules" }])} onDecide={onDecide} />);
    await userEvent.click(screen.getByRole("button", { name: /always/i }));
    expect(onDecide).toHaveBeenLastCalledWith({ kind: "always" });
    await userEvent.click(screen.getByRole("button", { name: /deny/i }));
    expect(onDecide).toHaveBeenLastCalledWith({ kind: "deny" });
  });
});

describe("PendingPrompt question", () => {
  it("single question, single-select answers on click", async () => {
    const onDecide = vi.fn();
    render(<PendingPrompt pending={q()} onDecide={onDecide} />);
    expect(screen.getByText("Q1?")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /develop/ }));
    expect(onDecide).toHaveBeenCalledWith({ kind: "answers", answers: { "Q1?": "develop" } });
  });
  it("multi-select joins with comma and needs Send", async () => {
    const onDecide = vi.fn();
    render(<PendingPrompt pending={q(true)} onDecide={onDecide} />);
    await userEvent.click(screen.getByRole("button", { name: /main/ }));
    await userEvent.click(screen.getByRole("button", { name: /develop/ }));
    expect(onDecide).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: /send/i }));
    expect(onDecide).toHaveBeenCalledWith({ kind: "answers", answers: { "Q1?": "main, develop" } });
  });
  it("free text goes to response", async () => {
    const onDecide = vi.fn();
    render(<PendingPrompt pending={q()} onDecide={onDecide} />);
    await userEvent.type(screen.getByPlaceholderText(/type an answer/i), "use trunk{Enter}");
    expect(onDecide).toHaveBeenCalledWith({ kind: "answers", answers: {}, response: "use trunk" });
  });
  it("two questions wait for both before Send is enabled", async () => {
    const onDecide = vi.fn();
    render(<PendingPrompt pending={q(false, 2)} onDecide={onDecide} />);
    await userEvent.click(screen.getAllByRole("button", { name: /main/ })[0]);
    expect(onDecide).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: /send/i })).toBeDisabled();
    await userEvent.click(screen.getAllByRole("button", { name: /develop/ })[1]);
    await userEvent.click(screen.getByRole("button", { name: /send/i }));
    expect(onDecide).toHaveBeenCalledWith({ kind: "answers", answers: { "Q1?": "main", "Q2?": "develop" } });
  });
});
