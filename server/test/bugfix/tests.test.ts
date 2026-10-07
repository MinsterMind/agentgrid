import { describe, it, expect } from "vitest";
import { isTestFile, testFilesIn } from "../../src/bugfix/tests.js";

describe("what counts as a test file", () => {
  it.each([
    ["src/cart.test.ts", true], ["src/cart.spec.tsx", true], ["pkg/cart_test.go", true], ["tests/test_cart.py", true],
    ["src/CartTest.java", true], ["src/CartTests.cs", true], ["test/fixtures/a.json", true], ["src/__tests__/a.js", true], ["spec/a.rb", true],
    ["fake-fix.test.txt", true],
    ["src/cart.ts", false], ["src/contest.ts", false], ["latest/x.ts", false], ["docs/testing.md", false], ["src/attest.ts", false], ["src/Latest.java", false],
  ])("%s → %s", (p, want) => expect(isTestFile(p)).toBe(want));
  it("filters a diff's files", () => expect(testFilesIn(["a.ts", "a.test.ts"])).toEqual(["a.test.ts"]));
});
