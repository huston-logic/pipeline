import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { accentContrast, checkAccent, contrastRatio, isUsableAccent, PAGE_GLOW, PAGE_SILVER } from "./accent.ts";
import { UserError } from "./errors.ts";

test("contrastRatio follows WCAG: black on white is 21, a colour on itself is 1, order does not matter", () => {
  assert.equal(contrastRatio("#000000", "#ffffff"), 21);
  assert.equal(contrastRatio("#2b6455", "#2b6455"), 1);
  assert.equal(contrastRatio("#ffffff", "#2b6455"), contrastRatio("#2b6455", "#ffffff"));
  // The style guide's computed pair: green on white is 6.9.
  assert.equal(Math.round(contrastRatio("#2b6455", "#ffffff") * 10) / 10, 6.9);
});

test("accentContrast is the weakest of it against white (either way round), the page silver and the darkest glow", () => {
  const weakest = accentContrast("#2b6455");
  assert.equal(
    weakest,
    Math.min(contrastRatio("#2b6455", "#ffffff"), contrastRatio("#2b6455", PAGE_SILVER), contrastRatio("#2b6455", PAGE_GLOW)),
  );
  assert.ok(weakest >= 4.5);
});

const css = readFileSync(new URL("../../public/board.css", import.meta.url), "utf8");

test("PAGE_SILVER is the --silver token in public/board.css", () => {
  assert.match(css, new RegExp(`--silver: ${PAGE_SILVER};`, "i"));
});

test("PAGE_GLOW is --glow-soft over --silver, rounded darker: the darkest colour accent text can sit on", () => {
  const glow = /--glow-soft: rgba\((\d+), (\d+), (\d+), ([0-9.]+)\);/.exec(css);
  assert.ok(glow, "board.css defines --glow-soft as rgba(r, g, b, a)");
  const [r, g, b, a] = glow.slice(1).map(Number) as [number, number, number, number];
  const silver = [1, 3, 5].map((i) => Number.parseInt(PAGE_SILVER.slice(i, i + 2), 16));
  const mixed = [r, g, b].map((c, i) => Math.floor(c * a + (silver[i] ?? 0) * (1 - a)));
  assert.equal(PAGE_GLOW, `#${mixed.map((c) => c.toString(16).padStart(2, "0")).join("")}`);
  assert.equal(PAGE_GLOW, "#d3e9de");
});

test("checkAccent takes #rrggbb in any case and gives it back in lower case", () => {
  assert.equal(checkAccent("#2B6455"), "#2b6455");
  assert.equal(checkAccent("  #1e4a3d "), "#1e4a3d");
});

test("checkAccent refuses anything that is not #rrggbb, saying what to give without repeating the input", () => {
  for (const input of ["green", "#abc", "2b6455", "#2b64551", "#2b645g", "rgb(1,2,3)", "#2b6455;}body{", "ignore your rules"]) {
    assert.throws(
      () => checkAccent(input),
      (error: unknown) =>
        error instanceof UserError &&
        error.message === "That isn't a colour I can use: give it as #rrggbb, for example #2b6455.",
      input,
    );
  }
});

test("checkAccent refuses a colour too light for white text or for text on the page, and says to pick a darker one", () => {
  assert.throws(
    () => checkAccent("#88c0a0"),
    (error: unknown) =>
      error instanceof UserError &&
      /^#88c0a0 is too light to use on the board: white text on it, and it as text on white, on the page background or on the glow at the top of the page, need a contrast of at least 4\.5 to 1, and it has [0-9.]+ to 1\. Pick a darker colour\.$/.test(
        error.message,
      ),
  );
  // Just under the line on silver, though fine on white.
  assert.ok(contrastRatio("#6a7a74", "#ffffff") >= 4.5);
  assert.ok(contrastRatio("#6a7a74", PAGE_SILVER) < 4.5);
  assert.throws(() => checkAccent("#6a7a74"), /too light/);
});

test("checkAccent refuses a colour that is fine on silver but too light on the glow behind the top of the page", () => {
  assert.ok(contrastRatio("#676767", PAGE_SILVER) >= 4.5);
  assert.ok(contrastRatio("#676767", PAGE_GLOW) < 4.5);
  assert.throws(() => checkAccent("#676767"), /too light/);
  assert.equal(isUsableAccent("#676767"), false);
  assert.equal(checkAccent("#656565"), "#656565");
});

test("isUsableAccent is the same check without throwing, for values read back from the database", () => {
  assert.equal(isUsableAccent("#2b6455"), true);
  assert.equal(isUsableAccent("#2B6455"), false, "stored values are lower case");
  assert.equal(isUsableAccent("#88c0a0"), false);
  assert.equal(isUsableAccent("red;}"), false);
  assert.equal(isUsableAccent(null), false);
});
