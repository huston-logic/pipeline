import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { accentContrast, checkAccent, contrastRatio, isUsableAccent, PAGE_SILVER } from "./accent.ts";
import { UserError } from "./errors.ts";

test("contrastRatio follows WCAG: black on white is 21, a colour on itself is 1, order does not matter", () => {
  assert.equal(contrastRatio("#000000", "#ffffff"), 21);
  assert.equal(contrastRatio("#2b6455", "#2b6455"), 1);
  assert.equal(contrastRatio("#ffffff", "#2b6455"), contrastRatio("#2b6455", "#ffffff"));
  // The style guide's computed pair: green on white is 6.9.
  assert.equal(Math.round(contrastRatio("#2b6455", "#ffffff") * 10) / 10, 6.9);
});

test("accentContrast is the weakest of white on it, it on white and it on the page silver", () => {
  const weakest = accentContrast("#2b6455");
  assert.equal(weakest, Math.min(contrastRatio("#2b6455", "#ffffff"), contrastRatio("#2b6455", PAGE_SILVER)));
  assert.ok(weakest >= 4.5);
});

test("PAGE_SILVER is the --silver token in public/board.css", () => {
  const css = readFileSync(new URL("../../public/board.css", import.meta.url), "utf8");
  assert.match(css, new RegExp(`--silver: ${PAGE_SILVER};`, "i"));
});

test("checkAccent takes #rrggbb in any case and gives it back in lower case", () => {
  assert.equal(checkAccent("#2B6455"), "#2b6455");
  assert.equal(checkAccent("  #1e4a3d "), "#1e4a3d");
});

test("checkAccent refuses anything that is not #rrggbb, saying what to give", () => {
  for (const input of ["green", "#abc", "2b6455", "#2b64551", "#2b645g", "rgb(1,2,3)", "#2b6455;}body{"]) {
    assert.throws(
      () => checkAccent(input),
      (error: unknown) =>
        error instanceof UserError &&
        error.message === `"${input}" isn't a colour I can use. Give a hex colour like #2b6455, or null to clear it.`,
      input,
    );
  }
});

test("checkAccent refuses a colour too light for white text or for text on the page, and says to pick a darker one", () => {
  assert.throws(
    () => checkAccent("#88c0a0"),
    (error: unknown) =>
      error instanceof UserError &&
      /^#88c0a0 is too light to use on the board: white text on it, and it as text on white or on the page background, need a contrast of at least 4\.5 to 1, and it has [0-9.]+ to 1\. Pick a darker colour\.$/.test(
        error.message,
      ),
  );
  // Just under the line on silver, though fine on white.
  assert.ok(contrastRatio("#6a7a74", "#ffffff") >= 4.5);
  assert.ok(contrastRatio("#6a7a74", PAGE_SILVER) < 4.5);
  assert.throws(() => checkAccent("#6a7a74"), /too light/);
});

test("isUsableAccent is the same check without throwing, for values read back from the database", () => {
  assert.equal(isUsableAccent("#2b6455"), true);
  assert.equal(isUsableAccent("#2B6455"), false, "stored values are lower case");
  assert.equal(isUsableAccent("#88c0a0"), false);
  assert.equal(isUsableAccent("red;}"), false);
  assert.equal(isUsableAccent(null), false);
});
