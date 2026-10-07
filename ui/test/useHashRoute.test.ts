import { describe, it, expect } from "vitest";
import { parseHash } from "../src/hooks/useHashRoute";

describe("parseHash", () => {
  it.each([
    ["", { view: "grid", bugId: null, ticket: null }], ["#/", { view: "grid", bugId: null, ticket: null }],
    ["#/bugs", { view: "bugs", bugId: null, ticket: null }], ["#/bugs/bt3", { view: "bugs", bugId: "bt3", ticket: null }],
    ["#/bugs/../x", { view: "bugs", bugId: null, ticket: null }], ["#/nonsense", { view: "grid", bugId: null, ticket: null }],
    ["#/bugs/ticket/PAY-42", { view: "bugs", bugId: null, ticket: "PAY-42" }],
    ["#/bugs/ticket/../x", { view: "bugs", bugId: null, ticket: null }],
  ])("%s", (h, want) => expect(parseHash(h)).toEqual(want));
describe("useHashRoute", () => {
  // Important #1: a fallback selection must replace the entry, or Back can never leave #/bugs.
  it("go with replace rewrites the current entry instead of pushing one", async () => {
    const { renderHook, act } = await import("@testing-library/react");
    const { useHashRoute } = await import("../src/hooks/useHashRoute");
    history.replaceState(null, "", "/");
    const { result } = renderHook(() => useHashRoute());
    act(() => result.current.go({ view: "bugs" }));
    const len = history.length;
    act(() => result.current.go({ view: "bugs", bugId: "bt1" }, { replace: true }));
    expect(history.length).toBe(len);
    expect(window.location.hash).toBe("#/bugs/bt1");
    expect(result.current.bugId).toBe("bt1");
    act(() => result.current.go({ view: "bugs", ticket: "PAY-42" }));
    expect(window.location.hash).toBe("#/bugs/ticket/PAY-42");
    expect(result.current.ticket).toBe("PAY-42"); expect(result.current.bugId).toBeNull();
  });
});
});
