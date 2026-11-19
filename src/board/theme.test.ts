import assert from "node:assert/strict";
import { test } from "node:test";
import { themeCss } from "./theme.ts";

test("a usable accent becomes the --accent token on :root", () => {
  assert.equal(themeCss("#1e4a3d"), ":root{--accent:#1e4a3d;}\n");
});

test("no accent gives a short comment, so the board's default accent stays", () => {
  assert.equal(themeCss(null), "/* No accent colour is set, so the board uses its default. */\n");
});

test("a stored value that fails the checks is never written out", () => {
  for (const bad of ["#88c0a0", "#1E4A3D", "#1e4a3d;}body{display:none", "</style>", "red"]) {
    const css = themeCss(bad);
    assert.equal(css, "/* The accent colour in the settings can't be used, so the board uses its default. */\n", bad);
    assert.ok(!css.includes(bad), bad);
  }
});
