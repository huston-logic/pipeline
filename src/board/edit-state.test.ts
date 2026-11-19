import assert from "node:assert/strict";
import { test } from "node:test";
import { compareField, fingerprint } from "./edit-state.ts";

test("a fingerprint is short, url-safe and the same for the same text", async () => {
  const a = await fingerprint("Pat Example", "line");
  assert.match(a, /^[A-Za-z0-9_-]{22}$/);
  assert.equal(await fingerprint("Pat Example", "line"), a);
  assert.notEqual(await fingerprint("Pat Exampl", "line"), a);
});

test("a field the owner left as it was is unchanged, so it is never written", async () => {
  const was = await fingerprint("Robin Sample", "line");
  assert.equal(await compareField("Robin Sample", was, "Robin Sample", "line"), "unchanged");
});

test("a field the owner changed is changed when nobody else changed it", async () => {
  const was = await fingerprint("555-0101", "line");
  assert.equal(await compareField("555-0199", was, "555-0101", "line"), "changed");
  assert.equal(await compareField("", was, "555-0101", "line"), "changed", "clearing is a change");
});

test("a field the owner left alone keeps another writer's newer value", async () => {
  const was = await fingerprint("old@example.com", "line");
  assert.equal(await compareField("old@example.com", was, "new@example.com", "line"), "unchanged");
});

test("both the owner and another writer changed it: a conflict, unless they agree", async () => {
  const was = await fingerprint("Example Plumbing", "line");
  assert.equal(await compareField("Example Plumbing Ltd", was, "Example Plumbing Co", "line"), "conflict");
  assert.equal(await compareField("Example Plumbing Co", was, "Example Plumbing Co", "line"), "unchanged");
});

test("what a browser does to an untouched value is not a change: CRLF in a textarea, newlines and edges in an input", async () => {
  const notes = "First line\nSecond line";
  assert.equal(await compareField("First line\r\nSecond line", await fingerprint(notes, "text"), notes, "text"), "unchanged");
  const name = "Robin\nSample";
  assert.equal(await compareField("RobinSample", await fingerprint(name, "line"), name, "line"), "unchanged");
  assert.equal(await compareField("  Pat Example ", await fingerprint("Pat Example", "line"), "Pat Example", "line"), "unchanged");
});

test("a field not posted at all is unchanged; one posted without a fingerprint is compared with the stored value", async () => {
  assert.equal(await compareField(null, null, "anything", "line"), "unchanged");
  assert.equal(await compareField("same", null, "same", "line"), "unchanged");
  assert.equal(await compareField("other", null, "same", "line"), "changed");
});
