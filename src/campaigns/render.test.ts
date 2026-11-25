import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import type { CampaignStepRow } from "../db/db.ts";
import { contrastRatio } from "../services/accent.ts";
import { EMAIL_COLORS, renderEmail } from "./render.ts";

function step(over: Partial<CampaignStepRow> = {}): CampaignStepRow {
  return {
    id: "cs_aaaaaaaaaaaa",
    campaign_id: "cp_aaaaaaaaaaaa",
    position: 1,
    subject: "Hello {{first_name}}",
    body: "Hi {{ FIRST_NAME }},\nSee https://example.com/a.\n\nSecond [{{first_name}} page](https://example.com/b?x=1&y=2)",
    button_label: "Book a call",
    button_url: "https://example.com/book",
    delay_days: null,
    stop_when: null,
    version: 1,
    created_at: "",
    updated_at: "",
    ...over,
  };
}

const frame = {
  business: "Example Co",
  postal: "1 Example St\nSpringfield, XX 00000",
  baseUrl: "https://pipeline.example.com",
  fallback: "there",
  accent: "#2b6455",
};

test("merges the first name or the fallback in subject and body", () => {
  const a = renderEmail(step(), { firstName: "Ana", token: "tok_1-x" }, frame);
  assert.equal(a.subject, "Hello Ana");
  assert.match(a.html, /<title>Hello Ana<\/title>/);
  assert.match(a.html, /Hi Ana,<br>See /);
  assert.match(a.text, /^Hi Ana,\nSee https:\/\/example\.com\/a\./);
  const b = renderEmail(step(), { firstName: null, token: "t" }, frame);
  assert.equal(b.subject, "Hello there");
  assert.match(b.html, /Hi there,/);
});

test("a merged value is escaped and never linked; hrefs are exact", () => {
  const out = renderEmail(step(), { firstName: "<b>x</b>", token: "t" }, frame);
  assert.ok(!out.html.includes("<b>x</b>"));
  assert.ok(out.html.includes("&lt;b&gt;x&lt;/b&gt;"));
  assert.ok(out.html.includes('<a href="https://example.com/b?x=1&amp;y=2"'));
  assert.ok(out.html.includes('<a href="https://example.com/a"'));
  assert.ok(!/href="[^"]*first_name/i.test(out.html));
});

test("never merges inside an href", () => {
  const out = renderEmail(
    step({ body: "[go](https://example.com/{{first_name}})" }),
    { firstName: "Ana", token: "t" },
    frame,
  );
  assert.ok(out.html.includes('href="https://example.com/{{first_name}}"'));
});

test("escapes markup in subject, body, business and postal address", () => {
  const out = renderEmail(
    step({ subject: 'A <script>"x"', body: 'Hi <script>alert("x")</script>' }),
    { firstName: null, token: "t" },
    { ...frame, business: 'B"<script>', postal: "<i>1 St</i>\nTown" },
  );
  assert.ok(!out.html.includes("<script>"));
  assert.ok(!out.html.includes("<i>"));
  assert.ok(out.html.includes("&lt;script&gt;"));
  assert.ok(out.html.includes("&quot;"));
  assert.ok(out.html.includes("&lt;i&gt;1 St&lt;/i&gt;<br>Town"));
});

test("footer holds business, postal address and the unsubscribe link", () => {
  const out = renderEmail(step(), { firstName: null, token: "tok_1-x" }, { ...frame, baseUrl: "https://pipeline.example.com/" });
  const url = "https://pipeline.example.com/unsubscribe/tok_1-x";
  assert.ok(out.html.includes(`<a href="${url}"`));
  assert.ok(out.html.includes("Unsubscribe from these emails"));
  assert.ok(out.html.includes("Example Co"));
  assert.ok(out.html.includes("1 Example St<br>Springfield, XX 00000"));
  assert.ok(out.text.endsWith(`--\nExample Co\n1 Example St\nSpringfield, XX 00000\nUnsubscribe: ${url}`));
});

test("html shell", () => {
  const out = renderEmail(step(), { firstName: null, token: "t" }, frame);
  assert.ok(out.html.startsWith("<!doctype html>"));
  assert.ok(out.html.includes('<html lang="en">'));
  assert.ok(out.html.includes('<meta charset="utf-8">'));
  assert.ok(out.html.includes('name="viewport"'));
  assert.ok(out.html.includes("max-width:600px"));
  assert.ok(!out.html.includes("<style"));
});

test("button uses the accent, with a text line; none when the step has none", () => {
  const out = renderEmail(step(), { firstName: null, token: "t" }, frame);
  assert.match(out.html, /<a href="https:\/\/example\.com\/book"[^>]*background:#2b6455[^>]*>Book a call<\/a>/);
  assert.ok(out.text.includes("Book a call: https://example.com/book"));
  const bad = renderEmail(step(), { firstName: null, token: "t" }, { ...frame, accent: "#ffff00" });
  assert.ok(bad.html.includes("background:#2b6455"));
  const none = renderEmail(step({ button_label: null, button_url: null }), { firstName: null, token: "t" }, frame);
  assert.ok(!none.html.includes("Book a call"));
  assert.ok(!none.html.includes("background:#2b6455"));
  assert.ok(!none.text.includes("Book a call"));
});

test("a button whose address isn't https is left out, even written straight into the row", () => {
  for (const button_url of ["HTTPS://example.com/x", "javascript:alert(1)", "https://user:pw@example.com/"]) {
    const out = renderEmail(step({ button_url }), { firstName: null, token: "t" }, frame);
    assert.ok(!out.html.includes("Book a call"), button_url);
    assert.ok(!out.html.includes(button_url), button_url);
    assert.ok(!out.text.includes("Book a call"), button_url);
  }
});

test("text part: paragraphs, text (url) and bare urls", () => {
  const out = renderEmail(step(), { firstName: "Ana", token: "t" }, frame);
  assert.ok(out.text.includes("Hi Ana,\nSee https://example.com/a.\n\nSecond Ana page (https://example.com/b?x=1&y=2)\n\n"));
});

test("subject is one plain line", () => {
  const out = renderEmail(step({ subject: "A\nB  {{first_name}}" }), { firstName: "Ana", token: "t" }, frame);
  assert.equal(out.subject, "A B Ana");
});

test("deterministic", () => {
  const r = { firstName: "Ana", token: "t" };
  assert.deepEqual(renderEmail(step(), r, frame), renderEmail(step(), r, frame));
});

test("email colours match board.css and keep AA contrast on white", () => {
  const css = readFileSync(new URL("../../public/board.css", import.meta.url), "utf8");
  const token = (name: string) => new RegExp(`--${name}:\\s*(#[0-9a-f]{6})`).exec(css)?.[1];
  assert.equal(EMAIL_COLORS.ink, token("ink"));
  assert.equal(EMAIL_COLORS.muted, token("ink-2"));
  assert.equal(EMAIL_COLORS.line, token("line"));
  assert.equal(EMAIL_COLORS.page, token("silver"));
  assert.ok(contrastRatio(EMAIL_COLORS.ink, "#ffffff") >= 4.5);
  assert.ok(contrastRatio(EMAIL_COLORS.muted, "#ffffff") >= 4.5);
});
