import assert from "node:assert/strict";
import { test } from "node:test";
import { importsOf, selectTests } from "./test-select.mjs";

// Ten unit tests so the 60% rule does not swallow the small selections below.
const filler = Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`src/z${i}.test.ts`, "// nothing"]));
const files = new Map(
  Object.entries({
    ...filler,
    "src/a.ts": "export const a = 1;",
    "src/a.test.ts": 'import { a } from "./a.ts";',
    "src/b.ts": 'import { a } from "./a.ts";\nexport const b = a;',
    "src/b.test.ts": 'import { b } from "./b.ts";',
    "src/c.ts": 'export * from "./b.ts";',
    "src/direct.test.ts": 'import "./a.ts";',
    "src/lazy.ts": 'export const load = () => import("./a.ts");',
    "src/lazy.test.ts": "import './lazy.ts';",
    "src/deep/d.ts": 'import { a } from "../a.ts";',
    "src/solo.ts": "export const solo = 1;",
    "scripts/tool.mjs": "export const t = 1;",
    "scripts/tool.test.mjs": 'import { t } from "./tool.mjs";',
    "scripts/reads-css.test.mjs": 'const css = "public/board.css";',
    "scripts/reads-base.test.mjs": 'readFileSync("docs/notes.txt")',
    "scripts/reads-doc.test.mjs": 'readFileSync("docs/SPEC.md")',
    "tests/helpers/people.ts": "export const p = 1;",
    "src/uses-people.test.ts": 'import { p } from "../tests/helpers/people.ts";',
  }),
);
const sel = (changed, f = files) => selectTests({ changed, files: f });

test("nothing changed selects nothing", () => {
  assert.equal(sel([]).mode, "none");
});

test("a deleted code file runs everything", () => {
  const r = sel(["src/gone.ts"]);
  assert.equal(r.mode, "all");
  assert.match(r.reasons.join("\n"), /src\/gone\.ts: deleted/);
});

test("config and shared setup files run everything", () => {
  for (const p of [
    "package.json",
    "package-lock.json",
    "tsconfig.json",
    "tests/a11y/tsconfig.json",
    "eslint.config.mjs",
    "wrangler.jsonc",
    "config/wrangler.copy.template.jsonc",
    "migrations/0001_init.sql",
    "seed/defaults.sql",
    "tests/helpers/workers-runtime.mjs",
    "tests/helpers/cloudflare-workers-stub.mjs",
  ]) {
    assert.equal(sel([p]).mode, "all", p);
  }
});

test("a changed unit test selects itself", () => {
  const r = sel(["src/a.test.ts"]);
  assert.deepEqual(r, { mode: "some", tests: ["src/a.test.ts"], reasons: r.reasons });
});

test("a changed code file selects its own test and tests importing it directly", () => {
  const r = sel(["src/a.ts"]);
  assert.equal(r.mode, "some");
  assert.deepEqual(r.tests, ["src/a.test.ts", "src/b.test.ts", "src/direct.test.ts", "src/lazy.test.ts"]);
});

test("importers are found through export-from, dynamic import, and import with no bindings", () => {
  assert.deepEqual(importsOf("src/x/y.ts", 'export * from "../a.ts"; import("./b.ts"); import \'./c.ts\'; import "pkg"; import z from "node:fs"'), [
    "src/a.ts",
    "src/x/b.ts",
    "src/x/c.ts",
  ]);
});

test("a non-test importer brings its own tests and the tests importing it", () => {
  // src/c.ts imports b.ts; changing b.ts pulls c.ts's tests (none) and importers' tests; changing a.ts reaches b.test.ts via b.ts too.
  const r = sel(["src/solo.ts"]);
  assert.equal(r.mode, "none");
  const r2 = sel(["src/b.ts"]);
  assert.deepEqual(r2.tests, ["src/b.test.ts"]);
  const r3 = sel(["src/deep/d.ts"]);
  assert.equal(r3.mode, "none");
  const more = new Map(files);
  more.set("src/deep/d.test.ts", 'import "./d.ts";');
  more.set("src/user.ts", 'import { a } from "./a.ts";');
  more.set("src/user.test.ts", 'import "./user.ts";');
  assert.ok(sel(["src/a.ts"], more).tests.includes("src/user.test.ts"));
});

test("sibling test and importer's sibling test are selected even when they do not import the file", () => {
  const f = new Map(files);
  f.set("src/e.ts", "export const e = 1;");
  f.set("src/e.test.ts", "// no import");
  f.set("src/f.ts", 'import { e } from "./e.ts";');
  f.set("src/f.test.ts", "// no import");
  assert.deepEqual(sel(["src/e.ts"], f).tests, ["src/e.test.ts", "src/f.test.ts"]);
});

test("helpers under tests/helpers select the tests that use them", () => {
  assert.deepEqual(sel(["tests/helpers/people.ts"]).tests, ["src/uses-people.test.ts"]);
});

test("a markdown or e2e or a11y or .claude or .github change selects only tests naming that path", () => {
  assert.deepEqual(sel(["docs/SPEC.md"]).tests, ["scripts/reads-doc.test.mjs"]);
  assert.equal(sel(["docs/other.md"]).mode, "none");
  assert.equal(sel(["tests/e2e/mcp.test.ts"]).mode, "none");
  assert.equal(sel(["tests/a11y/known-issues.ts"]).mode, "none");
  assert.equal(sel([".claude/hooks/x.mjs"]).mode, "none");
  assert.equal(sel([".github/workflows/ci.yml"]).mode, "none");
});

test("any other file selects tests naming its path or basename, else runs everything", () => {
  assert.deepEqual(sel(["public/board.css"]).tests, ["scripts/reads-css.test.mjs"]);
  assert.deepEqual(sel(["data/notes.txt"]).tests, ["scripts/reads-base.test.mjs"]);
  assert.equal(sel(["lighthouserc.cjs"]).mode, "all");
});

test("more than 60% of the unit tests runs everything", () => {
  const f = new Map(Array.from({ length: 5 }, (_, i) => [`src/t${i}.test.ts`, "x"]));
  assert.equal(sel(["src/t0.test.ts", "src/t1.test.ts", "src/t2.test.ts", "src/t3.test.ts"], f).mode, "all");
  assert.equal(sel(["src/t0.test.ts", "src/t1.test.ts", "src/t2.test.ts"], f).mode, "some");
});

test("reasons give one line per changed file", () => {
  const r = sel(["src/a.ts", "docs/SPEC.md"]);
  assert.equal(r.reasons.length, 2);
  assert.match(r.reasons[0], /^src\/a\.ts: own test \+ 4 importers/);
});
