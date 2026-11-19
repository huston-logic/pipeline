// Phone actions (decision 0021): a phone number or email address, often outside text, becomes a tel:, sms: or mailto:
// target only after strict normalisation; anything else gets no button.
import assert from "node:assert/strict";
import { test } from "node:test";
import { dialable, mailable, reachActions } from "./reach.ts";

const form = { csrf: "t".repeat(43), here: "/deals/dl_seed01" };

test("a phone number keeps a leading + and its digits once spaces, dashes, dots and brackets are gone", () => {
  const accepted: [string, string][] = [
    ["+1 (555) 010-0123", "+15550100123"],
    ["555-0101", "5550101"],
    ["555.010.0123", "5550100123"],
    ["(555) 010 0123", "5550100123"],
    ["+44 20 7946 0958", "+442079460958"],
    ["1234567", "1234567"],
    ["123456789012345", "123456789012345"],
  ];
  for (const [raw, out] of accepted) assert.equal(dialable(raw), out, raw);
});

test("a phone number with anything else in it, or too few or too many digits, is refused", () => {
  const refused = [
    "",
    "   ",
    "123456",
    "1234567890123456",
    "javascript:alert(1)",
    "tel:5550100123",
    "5550100123?body=hi",
    "5550100123;ext=1",
    "555 0101 ext 3",
    "5550100123%0A",
    "555%2C0100",
    "5550100123#",
    "5550100123,1",
    "+1+5550100123",
    "1+5550100123",
    "٥٥٥٠١٠٠١٢٣",
    "５５５０１００１２３",
    "555 0100123",
    "555\t0100123",
    "555\n0100123",
    "<b>5550100123</b>",
    '5550100123" onclick="x',
    "call me",
  ];
  for (const raw of refused) assert.equal(dialable(raw), null, JSON.stringify(raw));
  assert.equal(dialable(null), null);
});

test("an email address matching the strict pattern is used as it is", () => {
  for (const raw of ["pat@example.com", "pat.example+leads@mail.example.org", "p_a-t@mail-1.example.org", "PAT@Example.COM", "p.a.t@example.com", "_pat-@example.com"]) {
    assert.equal(mailable(raw), raw, raw);
  }
});

test("an email address with a query, an encoded character, quotes, spaces, slashes or a bad domain is refused", () => {
  const refused = [
    "",
    "pat",
    "@example.com",
    "pat@",
    "pat@example",
    "pat@@example.com",
    ".pat@example.com",
    "pat.@example.com",
    "pat..x@example.com",
    "..@example.com",
    "pat@example.com?subject=hi",
    "pat@example.com?body=hi",
    "pat@example.com&cc=x@example.com",
    "pat@example.com%0Abcc:x@example.com",
    "pat%40example.com",
    "pat@example.com#x",
    '"pat"@example.com',
    "pat'@example.com",
    "pat @example.com",
    " pat@example.com",
    "pat@example.com ",
    "pat/x@example.com",
    "pat@example.com/x",
    "pat\\x@example.com",
    "javascript:alert(1)//@example.com",
    "mailto:pat@example.com",
    "pat@exa_mple.com",
    "pat@.example.com",
    "pat@example..com",
    "pat@example.com.",
    "pat@-bad.example.com", "pat@bad-.example.com",
    "pät@example.com",
    "pat@exämple.com",
    "pat\n@example.com",
    "<pat@example.com>",
    `${"a".repeat(65)}@example.com`,
    `pat@${"a".repeat(250)}.com`,
  ];
  for (const raw of refused) assert.equal(mailable(raw), null, JSON.stringify(raw));
  assert.equal(mailable(null), null);
});

const contact = (over: Partial<{ phone: string | null; email: string | null; untrusted_fields: string[] }> = {}) => ({
  id: "ct_seed01",
  phone: "+1 (555) 010-0123",
  email: "pat@example.com",
  untrusted_fields: [],
  ...over,
});

test("usable values give Call, Text and Email links with fixed text, and the normalised value as the target", () => {
  const out = reachActions(contact(), { kind: "deal", id: "dl_seed01" }, form).toString();
  assert.match(out, /<a class="button reach-button" href="tel:\+15550100123" data-log="reach-log-call">Call<\/a>/);
  assert.match(out, /<a class="button reach-button" href="sms:\+15550100123" data-log="reach-log-text">Text<\/a>/);
  assert.match(out, /<a class="button reach-button" href="mailto:pat@example\.com" data-log="reach-log-email">Email<\/a>/);
});

test("the link text is fixed: the number or address never is a link's text (the contact card shows it, labelled)", () => {
  const out = reachActions(contact({ untrusted_fields: ["phone", "email"] }), { kind: "deal", id: "dl_seed01" }, form).toString();
  const texts = [...out.matchAll(/<a [^>]*>([^<]*)<\/a>/g)].map((m) => m[1]);
  assert.deepEqual(texts, ["Call", "Text", "Email"]);
  assert.doesNotMatch(out, /010-0123|>pat@example/);
});

test("one tap logs it: a POST form per channel to the subject's log route, with a fixed type and summary", () => {
  const deal = reachActions(contact(), { kind: "deal", id: "dl_seed01" }, form).toString();
  const expected = [
    ["call", "call", "Called.", "Log the call"],
    ["text", "note", "Sent a text message.", "Log the text"],
    ["email", "email", "Sent an email.", "Log the email"],
  ];
  for (const [key, type, summary, label] of expected) {
    assert.ok(
      deal.includes(
        `<form class="reach-log-form" method="post" action="/deals/dl_seed01/log"><input type="hidden" name="csrf" value="${form.csrf}"><input type="hidden" name="return_to" value="/deals/dl_seed01"><input type="hidden" name="type" value="${type}"><input type="hidden" name="summary" value="${summary}"><button class="button button-quiet reach-log-button" id="reach-log-${key}" type="submit">${label}</button></form>`,
      ),
      key,
    );
  }
  const onContact = reachActions(contact(), { kind: "contact", id: "ct_seed01" }, { ...form, here: "/contacts/ct_seed01" }).toString();
  assert.match(onContact, /action="\/contacts\/ct_seed01\/log"/);
  assert.doesNotMatch(onContact, /\/deals\//);
});

test("an unusable phone gives no Call, Text or their Log buttons, and says why; the email still works", () => {
  const out = reachActions(contact({ phone: "555-0101?body=hi" }), { kind: "deal", id: "dl_seed01" }, form).toString();
  assert.doesNotMatch(out, /href="(tel|sms):/);
  assert.doesNotMatch(out, /Log the (call|text)/);
  assert.match(out, /href="mailto:pat@example\.com"/);
  assert.match(out, /<p class="reach-note">The phone number can&#39;t be dialled as written, so there is no Call or Text button\. Edit the contact to fix it\.<\/p>/);
  assert.match(out, /<p class="reach-log-hint">Emailed\? Log it in one tap\.<\/p>/);
});

test("an unusable email gives no Email or Log the email button, and says why", () => {
  const out = reachActions(contact({ email: "robin@exa_mple.com" }), { kind: "deal", id: "dl_seed01" }, form).toString();
  assert.doesNotMatch(out, /mailto:/);
  assert.doesNotMatch(out, /Log the email/);
  assert.match(out, /<p class="reach-note">The email address isn&#39;t one this page can link to, so there is no Email button\. Edit the contact to fix it\.<\/p>/);
  assert.match(out, /<p class="reach-log-hint">Called or texted\? Log it in one tap\.<\/p>/);
});

test("no phone and no email: nothing at all", () => {
  assert.equal(reachActions(contact({ phone: null, email: null }), { kind: "deal", id: "dl_seed01" }, form), "");
  assert.equal(reachActions(contact({ phone: "  ", email: "" }), { kind: "deal", id: "dl_seed01" }, form), "");
});

test("an outside value with markup never reaches an href or the actions' markup (the card's rows show it, escaped)", () => {
  const out = reachActions(
    contact({ phone: '<img src=x onerror="alert(1)">', email: "x@example.com?body=<b>", untrusted_fields: ["phone", "email"] }),
    { kind: "deal", id: "dl_seed01" },
    form,
  ).toString();
  assert.doesNotMatch(out, /href="(tel|sms|mailto):/);
  assert.ok(!out.includes("img"));
  assert.ok(!out.includes("body="));
});
