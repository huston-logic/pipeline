import assert from "node:assert/strict";
import { test } from "node:test";
import { Html, html, raw } from "./html.ts";

test("escapes <script>, quotes and & in interpolations", () => {
  const evil = `<script>alert("x")</script> & 'y'`;
  const out = html`<p title="${evil}">${evil}</p>`;
  assert.ok(out instanceof Html);
  assert.equal(
    out.value,
    `<p title="&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; &#39;y&#39;">` +
      `&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; &#39;y&#39;</p>`,
  );
});

test("raw() markup is inserted unescaped", () => {
  assert.equal(html`<div>${raw("<b>bold</b>")}</div>`.value, "<div><b>bold</b></div>");
});

test("nested html fragments are not escaped twice", () => {
  const inner = html`<em>${"a & b"}</em>`;
  assert.equal(html`<p>${inner}</p>`.value, "<p><em>a &amp; b</em></p>");
});

test("arrays join with nothing between items, and each item is escaped", () => {
  const items = ["<one>", "two"].map((label) => html`<li>${label}</li>`);
  assert.equal(html`<ul>${items}</ul>`.value, "<ul><li>&lt;one&gt;</li><li>two</li></ul>");
  assert.equal(html`${["<a>", raw("<b>")]}`.value, "&lt;a&gt;<b>");
});

test("null, undefined and false render as nothing; numbers render as text", () => {
  assert.equal(html`[${null}${undefined}${false}${0}${42}]`.value, "[042]");
});
