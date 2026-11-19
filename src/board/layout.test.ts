import assert from "node:assert/strict";
import { test } from "node:test";
import { html } from "./html.ts";
import { renderPage } from "./layout.ts";

const page = (current?: string) =>
  renderPage({
    title: `Deals & "notes"`,
    description: "A <fake> description",
    body: html`<h1>Heading</h1>`,
    current,
  });

test("renders a full document with lang, viewport, title and meta description", () => {
  const out = page("/");
  assert.match(out, /^<!doctype html>/);
  assert.match(out, /<html lang="en">/);
  assert.match(out, /<meta name="viewport" content="width=device-width, initial-scale=1">/);
  assert.match(out, /<title>Deals &amp; &quot;notes&quot;<\/title>/);
  assert.match(out, /<meta name="description" content="A &lt;fake&gt; description">/);
  assert.match(out, /<link rel="stylesheet" href="\/board.css">/);
});

test("has a skip link, labelled nav, main#main and a footer", () => {
  const out = page("/");
  assert.match(out, /<a class="skip-link" href="#main">/);
  assert.match(out, /<nav aria-label="[^"]+">/);
  assert.match(out, /<main id="main"/);
  assert.match(out, /<footer/);
});

test("the layout adds no <h1> and no script of its own", () => {
  const out = page("/");
  assert.equal(out.match(/<h1[\s>]/g)?.length, 1);
  assert.doesNotMatch(out, /<script/i);
});

test("marks the current nav link with aria-current, and none when no route matches", () => {
  assert.match(page("/"), /<a href="\/" aria-current="page">/);
  assert.doesNotMatch(page(undefined), /aria-current/);
});
