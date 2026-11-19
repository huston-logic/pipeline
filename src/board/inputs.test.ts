import assert from "node:assert/strict";
import { test } from "node:test";
import { errorSummary, field } from "./inputs.ts";

const SCRIPT = "<script>alert(1)</script>";

test("a field has a visible label tied to its control, and says required in words", () => {
  const out = field({ id: "f-name", name: "name", label: "Name", kind: "text", value: "Pat", required: true }).value;
  assert.match(out, /<label for="f-name">Name <span class="field-required">\(required\)<\/span><\/label>/);
  assert.match(out, /<input id="f-name" name="name" type="text" value="Pat" autocomplete="off" required>/);
  const optional = field({ id: "f-phone", name: "phone", label: "Phone", kind: "tel", value: "" }).value;
  assert.match(optional, /<label for="f-phone">Phone<\/label>/);
  // Someone else's details: the browser's autofill would offer the owner's own.
  assert.match(optional, /type="tel" value="" autocomplete="off"/);
  assert.doesNotMatch(optional, /required/);
});

test("a hint and an error are read with the control, and the control is marked invalid", () => {
  const out = field({ id: "f-email", name: "email", label: "Email", kind: "email", value: "pat@", hint: "Their work email.", error: "Give an email address like name@example.com." }).value;
  assert.match(out, /<p class="field-hint" id="f-email-hint">Their work email\.<\/p>/);
  assert.match(out, /<p class="field-error" id="f-email-error"><span class="visually-hidden">Error: <\/span>Give an email address like name@example\.com\.<\/p>/);
  assert.match(out, /aria-describedby="f-email-hint f-email-error" aria-invalid="true"/);
  assert.match(out, /<div class="field field-invalid">/);
});

test("values are escaped, and an outside value carries the From outside label beside the field's label", () => {
  const out = field({ id: "f-name", name: "name", label: "Name", kind: "text", value: SCRIPT, outside: true }).value;
  assert.doesNotMatch(out, /<script>/);
  assert.match(out, /value="&lt;script&gt;alert\(1\)&lt;\/script&gt;"/);
  assert.match(out, /<label for="f-name">Name<\/label> <span class="outside">From outside<\/span>/);
  const notes = field({ id: "f-notes", name: "notes", label: "Notes", kind: "textarea", value: SCRIPT, outside: true }).value;
  assert.match(notes, /<textarea id="f-notes" name="notes" rows="4"[^>]*>&lt;script&gt;/);
});

test("the fingerprint the field was drawn with goes beside it as a hidden was.<name> field", () => {
  const out = field({ id: "f-name", name: "name", label: "Name", kind: "text", value: "Pat", was: "abc_DEF-123" }).value;
  assert.match(out, /<input type="hidden" name="was\.name" value="abc_DEF-123">/);
});

test("a choice field is a select with a blank option and the stored choice selected", () => {
  const out = field({ id: "f-tier", name: "cf.tier", label: "Tier", kind: "choice", value: "Warm", choices: ["Cold", "Warm"] }).value;
  assert.match(out, /<select id="f-tier" name="cf\.tier">/);
  assert.match(out, /<option value="">Not set<\/option>/);
  assert.match(out, /<option value="Warm" selected>Warm<\/option>/);
  const gone = field({ id: "f-tier", name: "cf.tier", label: "Tier", kind: "choice", value: "Lukewarm", choices: ["Cold"] }).value;
  assert.match(gone, /<option value="Lukewarm" selected>Lukewarm<\/option>/, "a stored value that is no longer a choice is still shown");
});

test("a choice with its own options has no blank option and shows each option's label", () => {
  const out = field({
    id: "f-type",
    name: "type",
    label: "Type",
    kind: "choice",
    value: "call",
    options: [{ value: "note", label: "Note" }, { value: "call", label: "Call" }],
  }).value;
  assert.match(out, /<select id="f-type" name="type">\n<option value="note">Note<\/option>\n<option value="call" selected>Call<\/option>\n<\/select>/);
});

test("a number field takes text with a decimal keypad, so a typed comma is not silently dropped", () => {
  const out = field({ id: "f-value", name: "value", label: "Value", kind: "number", value: "1500" }).value;
  assert.match(out, /type="text" value="1500" autocomplete="off" inputmode="decimal"/);
});

test("a date and time field is a group with its own legend, a date and an optional time", () => {
  const out = field({ id: "f-next", name: "next_at", label: "Next date", kind: "when", value: "2026-11-20T14:00", error: "Give a date for this time." }).value;
  assert.match(out, /<fieldset class="field field-when field-invalid">\n<legend>Next date<\/legend>/);
  assert.match(out, /<label for="f-next-date">Date<\/label>\n<input id="f-next-date" name="next_at\.date" type="date" value="2026-11-20" aria-describedby="f-next-error" aria-invalid="true">/);
  assert.match(out, /<label for="f-next-time">Time<\/label>\n<input id="f-next-time" name="next_at\.time" type="time" value="14:00" aria-describedby="f-next-error" aria-invalid="true">/);
  const dateOnly = field({ id: "f-next", name: "next_at", label: "Next date", kind: "when", value: "2026-11-20" }).value;
  assert.match(dateOnly, /name="next_at\.time" type="time" value=""/);
});

test("the error summary links each message to its field and is announced", () => {
  const out = errorSummary([
    { id: "f-name", message: "Give the person's name." },
    { message: "Another contact already uses that email." },
  ]).toString();
  assert.match(out, /<div class="error-summary" role="alert" aria-labelledby="error-summary-heading">/);
  assert.match(out, /<h2 id="error-summary-heading">2 things to fix<\/h2>/);
  assert.match(out, /<li><a href="#f-name">Give the person&#39;s name\.<\/a><\/li>/);
  assert.match(out, /<li>Another contact already uses that email\.<\/li>/);
  assert.equal(errorSummary([]), "");
});
