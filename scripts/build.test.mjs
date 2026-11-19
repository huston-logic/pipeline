import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { gzipSync } from "node:zlib";
import { SECURITY_HEADERS } from "../src/security.ts";
import { build } from "./build.mjs";
import { ICONS } from "./make-icons.mjs";

let outDir;

before(() => {
  outDir = join(mkdtempSync(join(tmpdir(), "pipeline-build-")), "out");
  build({ outDir });
});

after(() => rmSync(join(outDir, ".."), { recursive: true, force: true }));

const read = (name) => readFileSync(join(outDir, name), "utf8");

test("writes the five files CI checks, each non-empty", () => {
  for (const name of ["index.html", "404.html", "sitemap.xml", "robots.txt", "_headers"]) {
    assert.ok(statSync(join(outDir, name)).size > 0, `${name} is empty`);
  }
});

test("copies public/ (board.css and board.js) into out/", () => {
  assert.ok(statSync(join(outDir, "board.css")).size > 0);
  assert.ok(statSync(join(outDir, "board.js")).size > 0);
});

test("board.js stays small and plain: under 3 KB gzipped, no eval, no third-party code (decision 0014)", () => {
  const script = read("board.js");
  assert.ok(gzipSync(script).length < 3 * 1024, `${gzipSync(script).length} bytes gzipped`);
  assert.doesNotMatch(script, /\beval\(|new Function|innerHTML|import\(|https?:\/\//);
});

test("copies every icon from public/icons/ into out/icons/, byte for byte (decision 0019)", () => {
  for (const icon of ICONS) {
    const built = readFileSync(join(outDir, "icons", icon.file));
    assert.ok(built.equals(readFileSync(new URL(`../public/icons/${icon.file}`, import.meta.url))), icon.file);
  }
});

test("the static pages link the PNG favicon and no manifest (it needs a sign-in)", () => {
  for (const name of ["index.html", "404.html"]) {
    assert.match(read(name), /<link rel="icon" href="\/icons\/favicon-32.png" type="image\/png" sizes="32x32">/, name);
    assert.doesNotMatch(read(name), /manifest/, name);
  }
});

test("sitemap.xml is an empty <urlset> (decision 0003)", () => {
  const sitemap = read("sitemap.xml");
  assert.match(sitemap, /^<\?xml version="1.0" encoding="UTF-8"\?>/);
  assert.match(sitemap, /<urlset xmlns="http:\/\/www.sitemaps.org\/schemas\/sitemap\/0.9"><\/urlset>/);
  assert.doesNotMatch(sitemap, /<url>/);
});

test("robots.txt allows crawling and nothing says noindex (decision 0003)", () => {
  assert.match(read("robots.txt"), /User-agent: \*\s+Allow: \//);
  assert.doesNotMatch(read("robots.txt"), /Disallow: \//);
  for (const name of ["index.html", "404.html", "_headers"]) assert.doesNotMatch(read(name), /noindex/i, name);
});

test("the static pages are full documents with one <h1> and no script", () => {
  for (const name of ["index.html", "404.html"]) {
    const page = read(name);
    assert.match(page, /<html lang="en">/, name);
    assert.equal(page.match(/<h1[\s>]/g)?.length, 1, name);
    assert.match(page, /<meta name="description" content="[^"]+">/, name);
    assert.doesNotMatch(page, /<script/i, name);
  }
});

test("_headers sets exactly the Worker's security headers for static files", () => {
  const lines = read("_headers")
    .split("\n")
    .filter((line) => /^\s+\S+: /.test(line))
    .map((line) => line.trim());
  const expected = Object.entries(SECURITY_HEADERS).map(([name, value]) => `${name}: ${value}`);
  assert.deepEqual(lines.toSorted(), expected.toSorted());
  assert.doesNotMatch(read("_headers"), /unsafe-inline/);
  assert.match(read("_headers"), /script-src 'self';/);
});

test("a rebuild removes files left over from an earlier build", () => {
  writeFileSync(join(outDir, "stale.html"), "old");
  build({ outDir });
  assert.throws(() => statSync(join(outDir, "stale.html")), { code: "ENOENT" });
});
