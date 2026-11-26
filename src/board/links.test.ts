import assert from "node:assert/strict";
import { test } from "node:test";
import { linkify } from "./links.ts";

test("a trusted https address becomes a new-tab link with the address as its text", () => {
  assert.equal(
    linkify("See https://example.com/plan now", true).toString(),
    'See <a href="https://example.com/plan" target="_blank" rel="noopener noreferrer">https://example.com/plan<span class="visually-hidden"> (opens in a new tab)</span></a> now',
  );
});

test("one trailing punctuation mark is left outside the link", () => {
  assert.equal(
    linkify("Read http://example.org/a.", true).toString(),
    'Read <a href="http://example.org/a" target="_blank" rel="noopener noreferrer">http://example.org/a<span class="visually-hidden"> (opens in a new tab)</span></a>.',
  );
  assert.match(linkify("(https://example.net/x)", true).toString(), /href="https:\/\/example\.net\/x" /);
});

test("text that is not trusted is escaped and never linked", () => {
  assert.equal(linkify("Go to https://example.com <b>", false).toString(), "Go to https://example.com &lt;b&gt;");
});

test("only http and https are linked, and markup in the text is escaped", () => {
  const out = linkify("javascript:alert(1) data:text/html,x <script>", true).toString();
  assert.doesNotMatch(out, /<a /);
  assert.match(out, /&lt;script&gt;/);
  assert.doesNotMatch(linkify('https://example.com/"onmouseover="x', true).toString(), /"onmouseover/);
});
