import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { api, ApiError } from "../src/api";

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

describe("api client", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("listBugTasks: GET /api/bugtasks", async () => {
    fetchMock.mockResolvedValue(jsonResponse([{ id: "bt1" }]));
    const result = await api.listBugTasks();
    expect(fetchMock).toHaveBeenCalledWith("/api/bugtasks", { method: "GET", headers: {}, body: undefined });
    expect(result).toEqual([{ id: "bt1" }]);
  });

  it("createBugTask: POST /api/bugtasks with body", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ id: "bt1" }, 201));
    const input = { issueRef: "PAY-1", repo: "/r/repo", mergePolicy: "auto" as const, mergeMethod: "squash" };
    const result = await api.createBugTask(input);
    expect(fetchMock).toHaveBeenCalledWith("/api/bugtasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });
    expect(result).toEqual({ id: "bt1" });
  });

  it("bugPlan: GET /api/bugtasks/:id/plan", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ markdown: "# plan" }));
    const result = await api.bugPlan("bt1");
    expect(fetchMock).toHaveBeenCalledWith("/api/bugtasks/bt1/plan", { method: "GET", headers: {}, body: undefined });
    expect(result).toEqual({ markdown: "# plan" });
  });

  it("bugPlan encodes the task id in the URL", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ markdown: "" }));
    await api.bugPlan("bt/1 x");
    expect(fetchMock).toHaveBeenCalledWith(`/api/bugtasks/${encodeURIComponent("bt/1 x")}/plan`, expect.anything());
  });

  it("bugDiff: GET /api/bugtasks/:id/diff", async () => {
    const payload = { patch: "diff", files: [{ path: "a.ts", additions: 1, deletions: 0 }], additions: 1, deletions: 0 };
    fetchMock.mockResolvedValue(jsonResponse(payload));
    const result = await api.bugDiff("bt1");
    expect(fetchMock).toHaveBeenCalledWith("/api/bugtasks/bt1/diff", { method: "GET", headers: {}, body: undefined });
    expect(result).toEqual(payload);
  });

  it("approveBug: POST /api/bugtasks/:id/approve", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ id: "bt1", stage: "implementing" }));
    const result = await api.approveBug("bt1");
    expect(fetchMock).toHaveBeenCalledWith("/api/bugtasks/bt1/approve", { method: "POST", headers: {}, body: undefined });
    expect(result).toEqual({ id: "bt1", stage: "implementing" });
  });

  it("requestBugChanges: POST /api/bugtasks/:id/request-changes with body", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ id: "bt1", stage: "implementing" }));
    const result = await api.requestBugChanges("bt1", "please fix x");
    expect(fetchMock).toHaveBeenCalledWith("/api/bugtasks/bt1/request-changes", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "please fix x" }),
    });
    expect(result).toEqual({ id: "bt1", stage: "implementing" });
  });

  it("cancelBug: POST /api/bugtasks/:id/cancel", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ id: "bt1", stage: "cancelled" }));
    const result = await api.cancelBug("bt1");
    expect(fetchMock).toHaveBeenCalledWith("/api/bugtasks/bt1/cancel", { method: "POST", headers: {}, body: undefined });
    expect(result).toEqual({ id: "bt1", stage: "cancelled" });
  });

  it("retryBug: POST /api/bugtasks/:id/retry", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ id: "bt1", stage: "analyzing" }));
    const result = await api.retryBug("bt1");
    expect(fetchMock).toHaveBeenCalledWith("/api/bugtasks/bt1/retry", { method: "POST", headers: {}, body: undefined });
    expect(result).toEqual({ id: "bt1", stage: "analyzing" });
  });

  it("myIssues: GET /api/bugfix/issues", async () => {
    fetchMock.mockResolvedValue(jsonResponse([{ key: "PAY-1" }]));
    const result = await api.myIssues();
    expect(fetchMock).toHaveBeenCalledWith("/api/bugfix/issues", { method: "GET", headers: {}, body: undefined });
    expect(result).toEqual([{ key: "PAY-1" }]);
  });

  it("bugPreflight: GET /api/bugfix/preflight with encoded repo query string", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ ok: true, problems: [] }));
    const repo = "/Users/me/repos/my repo (2)";
    const result = await api.bugPreflight(repo);
    expect(fetchMock).toHaveBeenCalledWith(`/api/bugfix/preflight?repo=${encodeURIComponent(repo)}`, { method: "GET", headers: {}, body: undefined });
    // sanity: the encoded query string actually differs from the raw repo path (spaces/parens/slashes encoded)
    expect(encodeURIComponent(repo)).not.toBe(repo);
    expect(result).toEqual({ ok: true, problems: [] });
  });

  it("getIntegrations: GET /api/integrations", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ projectRepos: {} }));
    const result = await api.getIntegrations();
    expect(fetchMock).toHaveBeenCalledWith("/api/integrations", { method: "GET", headers: {}, body: undefined });
    expect(result).toEqual({ projectRepos: {} });
  });

  it("putIntegrations: PUT /api/integrations with body", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ projectRepos: { PAY: "/r/pay" } }));
    const patch = { tracker: { preset: "jira" } } as any;
    const result = await api.putIntegrations(patch);
    expect(fetchMock).toHaveBeenCalledWith("/api/integrations", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    });
    expect(result).toEqual({ projectRepos: { PAY: "/r/pay" } });
  });

  describe("error handling", () => {
    it("a rejecting fetch produces an ApiError with status 0 and a useful message", async () => {
      fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));
      await expect(api.listBugTasks()).rejects.toMatchObject({
        status: 0,
        message: expect.stringMatching(/never reached the server/i),
      });
    });

    it("preserves the original error as cause", async () => {
      const original = new TypeError("Failed to fetch");
      fetchMock.mockRejectedValue(original);
      try {
        await api.listBugTasks();
        expect.fail("expected api.listBugTasks() to throw");
      } catch (err) {
        expect(err).toBeInstanceOf(ApiError);
        expect((err as ApiError).cause).toBe(original);
      }
    });

    it("a non-2xx response still produces the real HTTP status", async () => {
      fetchMock.mockResolvedValue(jsonResponse({ error: "task not found" }, 404));
      await expect(api.approveBug("missing")).rejects.toMatchObject({ status: 404, message: "task not found" });
    });

    it("a 409 conflict surfaces its status", async () => {
      fetchMock.mockResolvedValue(jsonResponse({ error: "already approved" }, 409));
      await expect(api.approveBug("bt1")).rejects.toMatchObject({ status: 409, message: "already approved" });
    });

    it("a 501 (bugfix not wired) surfaces its status", async () => {
      fetchMock.mockResolvedValue(jsonResponse({ error: "the bug-fix workflow is not configured" }, 501));
      await expect(api.listBugTasks()).rejects.toMatchObject({ status: 501 });
    });

    it("a 204 response still short-circuits to undefined without parsing a body", async () => {
      fetchMock.mockResolvedValue(new Response(null, { status: 204 }));
      const result = await api.cancelBug("bt1");
      expect(result).toBeUndefined();
    });

    it("a 2xx response with a non-JSON body still behaves as before (unguarded res.json() rejects)", async () => {
      fetchMock.mockResolvedValue(new Response("not json", { status: 200 }));
      await expect(api.cancelBug("bt1")).rejects.toBeInstanceOf(SyntaxError);
    });
  });
});
