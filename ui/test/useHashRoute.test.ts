import { describe, it, expect } from "vitest";
import { parseHash } from "../src/hooks/useHashRoute";

describe("parseHash", () => {
  it.each([
    ["", { view: "grid", bugId: null }], ["#/", { view: "grid", bugId: null }],
    ["#/bugs", { view: "bugs", bugId: null }], ["#/bugs/bt3", { view: "bugs", bugId: "bt3" }],
    ["#/bugs/../x", { view: "bugs", bugId: null }], ["#/nonsense", { view: "grid", bugId: null }],
  ])("%s", (h, want) => expect(parseHash(h)).toEqual(want));
});
