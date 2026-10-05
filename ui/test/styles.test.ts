import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const css = readFileSync(path.resolve(__dirname, "../src/styles.css"), "utf8");
const main = readFileSync(path.resolve(__dirname, "../src/main.tsx"), "utf8");

describe("Mission Control tokens", () => {
  it.each([
    ["--bg", "#07090C"], ["--surface", "#0E1217"], ["--surface-raised", "#141A21"], ["--grid-line", "#1C242E"],
    ["--text", "#E6EDF3"], ["--text-muted", "#8B98A5"], ["--text-faint", "#56616D"],
    ["--st-working", "#22D3EE"], ["--st-needs-you", "#FBBF24"], ["--st-done", "#34D399"], ["--st-failed", "#F87171"],
    ["--st-idle", "#56616D"], ["--accent", "#22D3EE"], ["--accent-text", "#04121A"],
  ])("defines %s as %s", (name, value) => {
    expect(css).toMatch(new RegExp(`${name}:\\s*${value}`, "i"));
  });

  it("removes every old token name, with no aliases", () => {
    for (const old of ["--panel", "--line", "--fg", "--dim2", "--dim", "--blue", "--amber", "--green", "--red", "--grey"]) {
      expect(css).not.toMatch(new RegExp(`var\\(${old}\\)|${old}:`));
    }
  });

  it("no longer hard-codes the old palette", () => {
    for (const hex of ["#0f1115", "#161a21", "#1b1f27", "#2b3140", "#262a33", "#6b8cff", "#2563eb", "#12151b"]) {
      expect(css.toLowerCase()).not.toContain(hex);
    }
  });

  it("uses bundled fonts, never a CDN", () => {
    expect(main).toContain('@fontsource/inter');
    expect(main).toContain('@fontsource/jetbrains-mono');
    expect(css).not.toMatch(/fonts\.googleapis|iconify/);
    expect(css).toMatch(/font-family:\s*["']?Inter/);
  });

  it("turns off pulse and shimmer for reduced motion", () => {
    const block = css.slice(css.indexOf("prefers-reduced-motion"));
    expect(block).toMatch(/animation:\s*none/);
  });

  // I1: selection must survive a state's animated glow — its own channel (outline), declared after the state rules.
  it("marks the selected tile with an outline that state glows can't override", () => {
    const sel = css.lastIndexOf(".tile.selected");
    expect(css.slice(sel, css.indexOf("}", sel))).toMatch(/outline:\s*2px solid var\(--accent\)/);
    expect(sel).toBeGreaterThan(css.indexOf('.tile[data-state="waiting"]'));
  });

  // I2: --text-faint (#56616D) fails AA for text; essential copy must not use it.
  it.each([".sect-desc", ".hint", ".dim", ".empty", ".tile-state.free", ".side h4", ".panel-desc"])("%s is readable, not faint", sel => {
    const rules = css.split("}").filter(r => r.split("{")[0].split(",").some(s => s.trim() === sel || s.trim().endsWith(" " + sel)));
    expect(rules.length).toBeGreaterThan(0);
    for (const r of rules) { expect(r).not.toContain("--text-faint"); expect(r).not.toContain("--st-idle"); }
  });

  it("does not fade whole idle tiles (which fades their text too)", () => {
    expect(css).not.toMatch(/\.tile\[data-state="free"\]\s*\{[^}]*opacity/);
  });

  // M3: buttons grow for long labels instead of overflowing a fixed height.
  it("sizes buttons with min-height", () => {
    const at = css.search(/^\.btn \{/m);
    const btn = css.slice(at, css.indexOf("}", at));
    expect(btn).toMatch(/min-height:\s*28px/);
    expect(btn).not.toMatch(/(^|[ ;{])height:/);
  });


  it("keeps Now its own height beside Blocking, and drops the side panel's gate divider inside the Actions panel", () => {
    expect(css).toMatch(/\.row2\s*\{[^}]*align-items:\s*start/);
    expect(css).toMatch(/\.panel\.gates \.gate\s*\{[^}]*border-top:\s*0/);
  });

  // phase 2 I1: two plan columns only on the bug screen; the 340px side panel stays one column.
  it("lays plan cards in two columns only on the bug screen", () => {
    expect(css).not.toMatch(/(^|\})\s*\.plan\.structured\s*\{[^}]*grid-template-columns:\s*1fr 1fr/);
    expect(css).toMatch(/\.bugdetail \.plan\.structured\s*\{[^}]*grid-template-columns:\s*1fr 1fr/);
    expect(css).toMatch(/\.plansec\s*\{[^}]*overflow-wrap:\s*anywhere/);
  });
  // phase 2 M4
  it("lets an odd last plan card span the row instead of leaving an empty cell", () => {
    expect(css).toMatch(/\.plansec:last-child:nth-child\(odd\)\s*\{[^}]*grid-column:\s*1\s*\/\s*-1/);
  });

  it("defines the dialog primitives every dialog shares", () => {
    for (const sel of [".dlg-hd", ".dlg-body", ".dlg-ft", ".dlg-ic", ".field", ".label", ".help", ".input", ".errtext", ".oktext", ".warntext", ".seg", ".step-n", ".opt", ".radio", ".next"]) {
      expect(css).toMatch(new RegExp(`(^|[}\\s])${sel.replace(".", "\\.")}\\s*[{.:\\s,]`, "m"));
    }
    expect(css).toMatch(/\.modal\s*\{[^}]*backdrop-filter/);
  });

  // The legacy stacked-label rule (kept for the Sessions panel) must not hit the new field labels.
  it("keeps the legacy dialog label rule off the new .label and .help labels", () => {
    expect(css).not.toMatch(/(^|\})\s*\.dialog label\s*\{/);
    expect(css).toMatch(/\.dialog label:not\(\.label\):not\(\.help\)\s*\{/);
  });

  // From the phase 3 Settings screenshot: a fix (command row or hint) goes under its check, and
  // the segmented control keeps its natural width.
  it("puts a check's fix under it, and keeps the segmented control compact", () => {
    expect(css).toMatch(/\.checkrow\s*\{[^}]*flex-wrap:\s*wrap/);
    expect(css).toMatch(/\.checkrow > \.row, \.checkrow > \.hint\s*\{[^}]*flex-basis:\s*100%/);
    expect(css).toMatch(/\.seg\s*\{[^}]*align-self:\s*flex-start/);
  });
});
