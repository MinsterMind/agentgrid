import { describe, it, expect } from "vitest";
import { relativeTime } from "../src/format";

describe("relativeTime", () => {
  const now = Date.parse("2026-10-05T12:00:00Z");
  it.each([
    ["2026-10-05T11:59:40Z", "just now"], ["2026-10-05T11:54:00Z", "6 min ago"],
    ["2026-10-05T09:00:00Z", "3 h ago"], ["2026-10-03T12:00:00Z", "2 d ago"],
  ])("%s → %s", (iso, want) => expect(relativeTime(iso, now)).toBe(want));
  it("null is a dash", () => expect(relativeTime(null, now)).toBe("—"));
});
