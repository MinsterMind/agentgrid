import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TicketDetail } from "../src/components/TicketDetail";

const { ApiError } = vi.hoisted(() => {
  class ApiError extends Error { constructor(message: string, public status: number, _o?: unknown, public code?: string) { super(message); } }
  return { ApiError };
});
const TICKET = { key: "PAY-1", title: "Checkout totals are off", url: "https://jira/PAY-1", status: "To Do", priority: "High",
  description: "Steps:\n1. **Add** two items\n2. Apply a coupon", acceptanceCriteria: ["Totals match the cart", "Coupon applies once"] };
const issue = vi.fn(async (_k: string): Promise<unknown> => TICKET);
const createBugTask = vi.fn(async (i: object): Promise<object> => ({ id: "bt5", ...i }));
vi.mock("../src/api", () => ({ ApiError, api: {
  issue: (k: string) => issue(k), createBugTask: (i: object) => createBugTask(i),
  getIntegrations: async () => ({ projectRepos: { PAY: "/r/payments" } }),
  bugPreflight: async () => ({ ok: true, problems: [], remote: "github.com/acme/pay", baseBranch: "develop", branches: ["develop", "main"] }),
  pickFolder: vi.fn(),
} }));
beforeEach(() => { vi.clearAllMocks(); issue.mockImplementation(async () => TICKET); });

describe("TicketDetail", () => {
  it("shows the ticket — rendered, not raw — with its acceptance criteria", async () => {
    const { container } = render(<TicketDetail ticketKey="PAY-1" />);
    expect(await screen.findByRole("heading", { name: /Checkout totals are off/ })).toBeInTheDocument();
    expect(screen.getByText("High")).toBeInTheDocument(); expect(screen.getByText("To Do")).toBeInTheDocument();
    expect(container.querySelector("strong")).toHaveTextContent("Add");
    expect(container.textContent).not.toContain("**Add**");
    expect(screen.getByText("Totals match the cart")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /ticket/i })).toHaveAttribute("href", "https://jira/PAY-1");
  });
  it("starts the fix inline with the remembered repo and the branch it will be cut from", async () => {
    const onStarted = vi.fn();
    render(<TicketDetail ticketKey="PAY-1" onStarted={onStarted} />);
    await waitFor(() => expect(screen.getByLabelText("Repo")).toHaveValue("/r/payments"));
    expect(await screen.findByLabelText("Branch from")).toHaveValue("develop");
    await waitFor(() => expect(screen.getByRole("button", { name: "Start fixing" })).not.toBeDisabled());
    await userEvent.click(screen.getByRole("button", { name: "Start fixing" }));
    expect(createBugTask).toHaveBeenCalledWith({ issueRef: "PAY-1", repo: "/r/payments", mergePolicy: "ask", baseBranch: "develop" });
    await waitFor(() => expect(onStarted).toHaveBeenCalledWith(expect.objectContaining({ id: "bt5" })));
  });
  it("may already be fixed: shows the commits and Start anyway", async () => {
    createBugTask.mockImplementationOnce(async () => { throw new ApiError("PAY-1 may already be fixed: origin/develop has a commit naming it —\n  8561f07d PAY-1: fix totals", 409, undefined, "already-on-base"); });
    render(<TicketDetail ticketKey="PAY-1" />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Start fixing" })).not.toBeDisabled());
    await userEvent.click(screen.getByRole("button", { name: "Start fixing" }));
    expect(await screen.findByText(/8561f07d PAY-1: fix totals/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Start anyway" }));
    expect(createBugTask).toHaveBeenLastCalledWith(expect.objectContaining({ startAnyway: true }));
  });
  it("a ticket that can't be read says so, with Retry", async () => {
    issue.mockRejectedValueOnce(new Error("tracker unavailable"));
    render(<TicketDetail ticketKey="PAY-1" />);
    expect(await screen.findByText(/tracker unavailable/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /retry/i }));
    expect(await screen.findByRole("heading", { name: /Checkout totals are off/ })).toBeInTheDocument();
  });
});
