import assert from "node:assert/strict";
import { test } from "node:test";
import { html } from "./html.ts";
import { DEFAULT_THEME_COLOR, type Look, lookOf, renderPage, shortNameOf } from "./layout.ts";
import { moreItems, navItems } from "./routes.ts";

const page = (current?: string, look?: Look) =>
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
  assert.match(out, /<footer class="app-footer">\n<p>Add leads, edit contacts and deals, and move, log and undo here, or change anything by talking to your AI app\.<\/p>/);
});

test("the layout adds no <h1> and no script of its own", () => {
  const out = page("/");
  assert.equal(out.match(/<h1[\s>]/g)?.length, 1);
  assert.doesNotMatch(out, /<script/i);
});

test("the nav lists Today, Pipeline, People, Brief and More, then Rules, Changes, What it caught, Export, Notifications and Email logging under More", () => {
  const out = page("/");
  const hrefs = [...out.matchAll(/<nav[\s\S]*?<\/nav>/g)].flatMap((nav) => [...nav[0].matchAll(/<a href="([^"]+)"/g)].map((m) => m[1]));
  assert.deepEqual(hrefs, [
    "/",
    "/pipeline",
    "/contacts",
    "/brief",
    "/more",
    "/rules",
    "/changes",
    "/report",
    "/export",
    "/notifications",
    "/email-log",
  ]);
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
  for (const path of ["/leads", "/leads/new", "/companies", "/contacts/ct_abc"]) {
    assert.match(page(path), /<a href="\/contacts" aria-current="true">/, path);
  }
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
  assert.deepEqual(lookOf({ business_name: "Fernwood Engineering", accent_color: null }), { name: "Fernwood Engineering", themeColor: "#2b6455" });
  assert.deepEqual(lookOf({ business_name: null, accent_color: null }), { name: "Pipeline", themeColor: "#2b6455" });
});

test("lookOf's theme colour is a usable accent, or the default green when the stored value fails the checks", () => {
  assert.equal(lookOf({ business_name: null, accent_color: "#1e4a3d" }).themeColor, "#1e4a3d");
  for (const bad of ["#d0e8dc", "#1E4A3D", `#1e4a3d" onload="x`]) {
    assert.equal(lookOf({ business_name: null, accent_color: bad }).themeColor, DEFAULT_THEME_COLOR, bad);
  }
});

test("shortNameOf keeps a name of 12 characters or fewer and gives Pipeline for a longer one", () => {
  assert.equal(shortNameOf("Abcdefghijkl"), "Abcdefghijkl");
  assert.equal(shortNameOf("Abcdefghijklm"), "Pipeline");
  assert.equal(shortNameOf("Café & Co ☕"), "Café & Co ☕", "counts characters, not UTF-16 units");
});

test("every page links the PNG favicon, not a data: placeholder", () => {
  for (const out of [page("/"), page("/", { name: "Fernwood" })]) {
    assert.match(out, /<link rel="icon" href="\/icons\/favicon-32.png" type="image\/png" sizes="32x32">/);
    assert.doesNotMatch(out, /href="data:/);
  }
});

test("signed-in pages link the manifest with credentials, the theme colour, the apple-touch icon and the app title", () => {
  const named = renderPage({
    title: "Today",
    description: "x",
    body: html`<h1>Today</h1>`,
    frame: { look: { name: `Fern & <Co>`, themeColor: "#1e4a3d" } },
  });
  assert.match(named, /<link rel="manifest" href="\/manifest.webmanifest" crossorigin="use-credentials">/);
  assert.match(named, /<meta name="theme-color" content="#1e4a3d">/);
  assert.match(named, /<link rel="apple-touch-icon" href="\/icons\/apple-touch-icon.png">/);
  assert.match(named, /<meta name="apple-mobile-web-app-title" content="Fern &amp; &lt;Co&gt;">/);

  const long = page("/", { name: "Fernwood Engineering" });
  assert.match(long, /<meta name="apple-mobile-web-app-title" content="Pipeline">/);
  assert.match(long, /<meta name="theme-color" content="#2b6455">/, "a look without a colour gets the default");
});

test("pages drawn without a sign-in link no manifest and no apple-touch icon", () => {
  const plain = page("/");
  assert.doesNotMatch(plain, /manifest|apple-touch-icon|apple-mobile-web-app-title|theme-color/);
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

test('script: "push" loads only /push.js with defer (the Notifications page, decision 0030)', () => {
  const out = renderPage({ title: "Notifications", description: "x", body: html`<h1>Notifications</h1>`, script: "push" });
  assert.equal(out.match(/<script\b/g)?.length, 1);
  assert.match(out, /<script src="\/push.js" defer><\/script>\n<\/head>/);
  assert.doesNotMatch(out, /board\.js/);
});
