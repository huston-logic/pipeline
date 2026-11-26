import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { Script } from "node:vm";
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

test("board.js stays small and plain: under 3 KB gzipped, no eval, no third-party code (decisions 0014, 0021)", () => {
  const script = read("board.js");
  assert.ok(gzipSync(script).length < 3 * 1024, `${gzipSync(script).length} bytes gzipped`);
  assert.doesNotMatch(script, /\beval\(|new Function|innerHTML|outerHTML|insertAdjacentHTML|document\.write|\bfetch\(|XMLHttpRequest|import\(|https?:\/\//);
});

test("live.js stays small and plain: under 3 KB gzipped, no eval, no HTML strings, no third-party code, no history (decision 0062)", () => {
  const script = read("live.js");
  assert.ok(gzipSync(script).length < 3 * 1024, `${gzipSync(script).length} bytes gzipped`);
  assert.doesNotMatch(script, /\beval\(|new Function|innerHTML|outerHTML|insertAdjacentHTML|document\.write|XMLHttpRequest|import\(|https?:\/\/|pushState|localStorage|sendBeacon/);
  assert.deepEqual(script.match(/\bhistory\.\w+/g), ["history.replaceState"], "the address changes only for a filter, by replacing it");
  assert.doesNotThrow(() => new Script(script), "live.js parses");
  assert.equal(script.match(/\bfetch\(/g)?.length, 2, "the form's post, then a GET of a page");
  assert.match(script, /X-Location/);
  assert.match(script, /to\.origin !== location\.origin/, "a foreign address is never fetched");
  assert.match(script, /fetch\(form\.action, \{\s*method: "POST",\s*headers: \{ "X-Live": "1" \},[^]*credentials: "same-origin",?\s*\}\)/, "the form's own action, same origin");
  assert.match(script, /fetch\(url, \{ credentials: "same-origin" \}\)/, "a GET of a board path");
  assert.match(script, /new DOMParser\(\)\.parseFromString\(/);
});

test("board.js copies prompts with the clipboard API and moves focus to the Log button after Call, Text or Email (decision 0021)", () => {
  const script = read("board.js");
  assert.match(script, /navigator\.clipboard\.writeText\(/);
  assert.match(script, /"Copied\."/);
  // The live region is emptied first, so a second Copy prompt is announced again.
  assert.match(script, /status\.textContent = "";\s*navigator\.clipboard\.writeText\(/);
  // A page can say what to do when copying fails (the email log address, decision 0031); Ask Claude keeps its words.
  assert.match(script, /button\.dataset\.copyFail \|\| "Couldn't copy\. Open Show the prompt and copy it from there\."/);
  assert.match(script, /\[data-log\]/);
  assert.match(script, /\.focus\(\)/);
  assert.doesNotMatch(script, /\balert\(|\bconfirm\(|\bprompt\(/);
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
