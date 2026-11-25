import assert from "node:assert/strict";
import { test } from "node:test";
import { isHttpsUrl, parseBody } from "./body.ts";

test("paragraphs split on blank lines and single line breaks stay as lines", () => {
  const blocks = parseBody("Hi {{first_name}},\nhope you are well.\n\n\n  \nSecond paragraph.\r\nStill second.");
  assert.deepEqual(blocks, [
    { lines: [[{ kind: "text", text: "Hi {{first_name}}," }], [{ kind: "text", text: "hope you are well." }]] },
    { lines: [[{ kind: "text", text: "Second paragraph." }], [{ kind: "text", text: "Still second." }]] },
  ]);
  assert.deepEqual(parseBody("  \n\n"), []);
});

test("markdown links and bare https URLs become links", () => {
  const [block] = parseBody("See [our page](https://example.com/a?b=1) or https://example.org/x, thanks.");
  assert.deepEqual(block?.lines[0], [
    { kind: "text", text: "See " },
    { kind: "link", text: "our page", href: "https://example.com/a?b=1" },
    { kind: "text", text: " or " },
    { kind: "link", text: "https://example.org/x", href: "https://example.org/x" },
    { kind: "text", text: ", thanks." },
  ]);
});

test("trailing punctuation stays outside a bare link", () => {
  const [block] = parseBody("Visit (https://example.com/path).");
  assert.deepEqual(block?.lines[0], [
    { kind: "text", text: "Visit (" },
    { kind: "link", text: "https://example.com/path", href: "https://example.com/path" },
    { kind: "text", text: ")." },
  ]);
});

test("only https makes a link", () => {
  for (const text of [
    "http://example.com/a",
    "[x](http://example.com/a)",
    "[x](javascript:alert(1))",
    "[x](mailto:pat@example.com)",
    "[x](https://user:pw@example.com/)",
    "mailto:pat@example.com",
    "[x](https://)",
  ]) {
    const [block] = parseBody(text);
    assert.deepEqual(block?.lines[0], [{ kind: "text", text }], text);
  }
});

test("isHttpsUrl accepts a plain https address only", () => {
  assert.equal(isHttpsUrl("https://example.com/book"), true);
  for (const bad of ["http://example.com", "javascript:alert(1)", "https://u:p@example.com", "example.com", "https://exa mple.com", ""]) {
    assert.equal(isHttpsUrl(bad), false, bad);
  }
});
