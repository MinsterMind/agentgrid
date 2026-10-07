import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { PendingPrompt } from "../src/components/PendingPrompt";
import type { Pending } from "../src/types";

const perm = (suggestions: unknown[] = []): Pending => ({ kind: "permission", toolUseId: "t1", toolName: "Bash", input: { command: "kubectl rollout restart deploy/api" }, suggestions, suggestedRule: "Bash(kubectl rollout:*)", ruleIsBroad: false });
const q = (multi = false, n = 1): Pending => ({ kind: "question", toolUseId: "t2", toolName: "AskUserQuestion", suggestions: [], suggestedRule: "", ruleIsBroad: false, input: { questions: Array.from({ length: n }, (_, i) => ({
  question: `Q${i + 1}?`, header: `H${i + 1}`, multiSelect: multi, options: [{ label: "main", description: "d1" }, { label: "develop", description: "d2" }] })) } });

describe("PendingPrompt permission", () => {
  it("shows the command with Allow, Always allow <its rule>, and Deny", async () => {
    const onDecide = vi.fn();
    render(<PendingPrompt pending={perm()} onDecide={onDecide} />);
    expect(screen.getByText(/kubectl rollout restart/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /^allow$/i }));
    expect(onDecide).toHaveBeenCalledWith({ kind: "allow" });
    await userEvent.click(screen.getByRole("button", { name: "Always allow Bash(kubectl rollout:*)" }));
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
  it("describes a permission request in a sentence above the exact command", () => {
    render(<PendingPrompt who="Cody" pending={{ kind: "permission", toolUseId: "t", toolName: "Bash", input: { command: "kubectl rollout restart deploy/api" }, suggestions: [], suggestedRule: "Bash(kubectl rollout:*)", ruleIsBroad: false }} onDecide={vi.fn()} />);
    const box = screen.getByTestId("pending-permission");
    expect(box).toHaveTextContent("Cody wants to run a shell command");
    expect(box.querySelector(".cmd")).toHaveTextContent("kubectl rollout restart deploy/api");
  });

  it("makes Allow the primary action, the same as on the tile", () => {
    render(<PendingPrompt pending={perm()} onDecide={vi.fn()} />);
    expect(screen.getByRole("button", { name: /^allow$/i })).toHaveClass("p");
  });

});

describe("PendingPrompt always-allow rules", () => {
  it("asks again before saving a broad rule", async () => {
    const onDecide = vi.fn();
    render(<PendingPrompt pending={{ kind: "permission", toolUseId: "t", toolName: "Bash", input: { command: "rm -rf build" }, suggestions: [], suggestedRule: "Bash", ruleIsBroad: true }} onDecide={onDecide} />);
    await userEvent.click(screen.getByRole("button", { name: "Always allow Bash" }));
    expect(onDecide).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Confirm: always allow every shell command" }));
    expect(onDecide).toHaveBeenCalledWith({ kind: "always" });
  });
  it("a broad file rule says so; clicking elsewhere backs out", async () => {
    const onDecide = vi.fn();
    render(<PendingPrompt pending={{ kind: "permission", toolUseId: "t", toolName: "Edit", input: { file_path: "/a" }, suggestions: [], suggestedRule: "Edit", ruleIsBroad: true }} onDecide={onDecide} />);
    await userEvent.click(screen.getByRole("button", { name: "Always allow Edit" }));
    expect(screen.getByRole("button", { name: "Confirm: always allow every file change" })).toBeInTheDocument();
    await userEvent.click(screen.getByText(/wants to change a file/i));
    expect(screen.getByRole("button", { name: "Always allow Edit" })).toBeInTheDocument();
    expect(onDecide).not.toHaveBeenCalled();
  });
});
