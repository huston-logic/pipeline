import assert from "node:assert/strict";
import { test } from "node:test";
import { html } from "./html.ts";
import { lookOf, renderPage } from "./layout.ts";
import { moreItems, navItems } from "./routes.ts";

const page = (current?: string, look?: { name: string }) =>
  renderPage({
    title: `Deals & "notes"`,
    description: "A <fake> description",
    body: html`<h1>Heading</h1>`,
    current,
    frame: look === undefined ? undefined : { look },
  });

test("renders a full document with lang, a viewport that covers the safe areas, title and meta description", () => {
  const out = page("/");
  assert.match(out, /^<!doctype html>/);
  assert.match(out, /<html lang="en">/);
  assert.match(out, /<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">/);
  assert.match(out, /<title>Deals &amp; &quot;notes&quot; · Pipeline<\/title>/);
  assert.match(out, /<meta name="description" content="A &lt;fake&gt; description">/);
  assert.match(out, /<link rel="stylesheet" href="\/board.css">/);
});

test("has a skip link first, a header, one labelled nav, main#main and a footer", () => {
  const out = page("/");
  assert.ok(out.indexOf('<a class="skip-link" href="#main">') < out.indexOf("<header"), "skip link before the header");
  assert.match(out, /<header class="app-header">/);
  assert.equal(out.match(/<nav\b/g)?.length, 1);
  assert.match(out, /<nav class="app-nav" aria-label="Board pages">/);
  assert.match(out, /<main id="main"/);
  assert.match(out, /<footer class="app-footer">\n<p>Move deals and undo changes here, or change anything by talking to your AI app\.<\/p>/);
});

test("the layout adds no <h1> and no script of its own", () => {
  const out = page("/");
  assert.equal(out.match(/<h1[\s>]/g)?.length, 1);
  assert.doesNotMatch(out, /<script/i);
});

test("the nav lists Today, Pipeline, Contacts, Brief and More, then Rules, Changes and Export under More", () => {
  const out = page("/");
  const hrefs = [...out.matchAll(/<nav[\s\S]*?<\/nav>/g)].flatMap((nav) => [...nav[0].matchAll(/<a href="([^"]+)"/g)].map((m) => m[1]));
  assert.deepEqual(hrefs, ["/", "/pipeline", "/contacts", "/brief", "/more", "/rules", "/changes", "/export"]);
  for (const item of [...navItems, ...moreItems]) {
    assert.match(out, new RegExp(`<svg [^>]*aria-hidden="true"[^>]*>[\\s\\S]*?</svg><span class="nav-label">${item.label}</span>`), item.label);
  }
});

test("the More link says More pages to assistive technology, so its text is descriptive", () => {
  assert.match(page("/"), /<a href="\/more"><svg [^>]*>[\s\S]*?<\/svg><span class="nav-label">More<\/span><span class="visually-hidden"> pages<\/span><\/a>/);
});

test("the current page is aria-current=page; a page inside a section marks the section with aria-current=true", () => {
  const home = page("/");
  assert.equal(home.match(/aria-current=/g)?.length, 1);
  assert.match(home, /<a href="\/" aria-current="page">/);

  const rules = page("/rules");
  assert.match(rules, /<a href="\/rules" aria-current="page">/);
  assert.match(rules, /<a href="\/more" aria-current="true">/);
  assert.equal(rules.match(/aria-current=/g)?.length, 2);

  assert.match(page("/deals/dl_abc"), /<a href="\/pipeline" aria-current="true">/);
  assert.doesNotMatch(page(undefined), /aria-current/);
});

test("without a look the page says Pipeline and links no theme; with one it shows the business name and /theme.css", () => {
  const plain = page("/");
  assert.match(plain, /<span class="brand-mark" aria-hidden="true">P<\/span><span class="brand-name">Pipeline<\/span>/);
  assert.doesNotMatch(plain, /theme\.css/);

  const named = page("/", { name: `Fernwood & <Sons>` });
  assert.match(named, /<title>Deals &amp; &quot;notes&quot; · Fernwood &amp; &lt;Sons&gt;<\/title>/);
  assert.match(named, /<span class="brand-mark" aria-hidden="true">F<\/span><span class="brand-name">Fernwood &amp; &lt;Sons&gt;<\/span>/);
  assert.match(named, /<link rel="stylesheet" href="\/board.css">\n<link rel="stylesheet" href="\/theme.css">/);
});

test("lookOf uses the business name, or Pipeline when none is set", () => {
  assert.deepEqual(lookOf({ business_name: "Fernwood Engineering" }), { name: "Fernwood Engineering" });
  assert.deepEqual(lookOf({ business_name: null }), { name: "Pipeline" });
});

test("a change banner from the frame sits right after the page's h1, so it is the first thing read after the heading", () => {
  const frame = { look: { name: "Pipeline" }, banner: html`<div class="banner" role="status">Moved</div>` };
  const out = renderPage({ title: "Pipeline", description: "x", body: html`<h1>Pipeline</h1>\n<p>Rest</p>`, frame });
  assert.match(out, /<main id="main">\n<h1>Pipeline<\/h1>\n<div class="banner" role="status">Moved<\/div>\n<p>Rest<\/p>/);
  const backFirst = renderPage({ title: "Deal", description: "x", body: html`<p class="back">Back</p>\n<h1>Deal</h1>\n<p>Rest</p>`, frame });
  assert.match(backFirst, /<h1>Deal<\/h1>\n<div class="banner" role="status">Moved<\/div>\n<p>Rest<\/p>/);
});

test("script: true loads /board.js with defer in the head; pages without it load no script", () => {
  const out = renderPage({ title: "Pipeline", description: "x", body: html`<h1>Pipeline</h1>`, script: true });
  assert.equal(out.match(/<script\b/g)?.length, 1);
  assert.match(out, /<script src="\/board.js" defer><\/script>\n<\/head>/);
  assert.doesNotMatch(page("/"), /board\.js/);
});
