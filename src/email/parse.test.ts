import assert from "node:assert/strict";
import { test } from "node:test";
import { CLOUDFLARE_PASS, rawEmail } from "../../tests/helpers/fake-email.ts";
import {
  authPasses,
  MAX_BODY_CHARS,
  MAX_MESSAGE_KEY_CHARS,
  MAX_SUBJECT_CHARS,
  messageKey,
  occurredAt,
  parseEmail,
  untrustedText,
} from "./parse.ts";

const auth = (...values: string[]) => values.map((value) => ({ key: "authentication-results", value }));
const NOW = new Date("2026-11-20T18:00:00.000Z");

test("authPasses: Cloudflare's dmarc=pass, or with no dmarc result both spf=pass and dkim=pass (Ruling 3)", () => {
  assert.equal(authPasses(auth(CLOUDFLARE_PASS)), true);
  assert.equal(authPasses(auth("mx.cloudflare.net; spf=pass smtp.mailfrom=owner@example.com; dkim=pass header.d=example.com")), true);
  assert.equal(authPasses(auth("mx.cloudflare.net; dmarc=pass header.from=example.com")), true);
  assert.equal(authPasses(auth("MX.Cloudflare.NET 1; DMARC=Pass (p=reject dis=none) header.from=example.com")), true);
  assert.equal(authPasses(auth("mx.cloudflare.net (the receiver); spf=pass; dkim=pass")), true);
});

test("authPasses: anything short of that is a fail", () => {
  assert.equal(authPasses([]), false, "no header");
  assert.equal(authPasses(auth("mx.cloudflare.net; none")), false, "no results");
  assert.equal(authPasses(auth("mx.cloudflare.net; spf=pass; dkim=pass; dmarc=fail")), false, "dmarc fail wins");
  assert.equal(authPasses(auth("mx.cloudflare.net; spf=pass; dkim=pass; dmarc=none")), false, "dmarc none");
  assert.equal(authPasses(auth("mx.cloudflare.net; spf=pass")), false, "spf alone");
  assert.equal(authPasses(auth("mx.cloudflare.net; dkim=pass")), false, "dkim alone");
  assert.equal(authPasses(auth("mx.cloudflare.net; spf=softfail; dkim=pass")), false, "spf softfail");
  assert.equal(authPasses(auth("mx.cloudflare.net; dmarc=pass; dmarc=fail")), false, "two dmarc results, one fails");
  assert.equal(authPasses(auth("mx.cloudflare.net; spf=pass; dkim=pass; dkim=fail")), false, "two dkim results, one fails");
});

test("authPasses trusts only the first header from mx.cloudflare.net, never one the sender wrote", () => {
  const forged = "mx.cloudflare.net; spf=pass; dkim=pass; dmarc=pass";
  assert.equal(authPasses(auth("mx.cloudflare.net; spf=fail; dkim=none; dmarc=fail", forged)), false, "a forged earlier header below");
  assert.equal(authPasses(auth("mail.example.net; spf=pass; dkim=pass; dmarc=pass")), false, "another receiver's verdict");
  assert.equal(
    authPasses(auth("mail.example.net; dmarc=pass", "mx.cloudflare.net; dmarc=fail")),
    false,
    "another receiver's pass above Cloudflare's fail",
  );
  assert.equal(authPasses(auth("mx.cloudflare.net.example.org; dmarc=pass")), false, "a look-alike authserv-id");
  assert.equal(authPasses(auth("mail.example.net; dmarc=fail", CLOUDFLARE_PASS)), true, "Cloudflare's pass below another's");
});

test("authPasses ignores results hidden in quoted strings and comments", () => {
  assert.equal(authPasses(auth('mx.cloudflare.net; spf=fail smtp.mailfrom="x;dmarc=pass"@example.com; dkim=fail')), false);
  assert.equal(authPasses(auth("mx.cloudflare.net; spf=fail (; dmarc=pass) smtp.mailfrom=owner@example.com")), false);
  assert.equal(authPasses(auth("mx.cloudflare.net; spf=pass (nested (; dmarc=fail)) ; dkim=pass")), true);
});

test("parseEmail reads the header From, the To and Cc people, the subject, the date, the Message-ID and the text", async () => {
  const email = await parseEmail(
    rawEmail({
      to: "Pat Example <PAT@example.com>, robin@example.net",
      cc: "Team: sam@example.org, Pat@Example.com;, lee@example.com",
      subject: "Next steps",
      text: "Line one\r\nLine two",
    }),
  );
  assert.equal(email.from, "owner@example.com");
  assert.deepEqual(email.recipients, ["pat@example.com", "robin@example.net", "sam@example.org", "lee@example.com"]);
  assert.equal(email.subject, "Next steps");
  assert.equal(email.messageId, "<fake-1@mail.example.com>");
  assert.equal(email.date, "2026-11-19T17:30:00.000Z");
  assert.equal(email.body, "Line one\nLine two");
  assert.equal(email.headers.filter((h) => h.key === "authentication-results").length, 1);
});

test("parseEmail prefers the text part, falls back to the HTML as text, and ignores attachments", async () => {
  const both = await parseEmail(rawEmail({ text: "Plain words", html: "<p>Rich <b>words</b></p>" }));
  assert.equal(both.body, "Plain words");
  const htmlOnly = await parseEmail(rawEmail({ html: "<p>Hello <b>Pat</b></p><p>See you &amp; soon</p>" }));
  assert.match(htmlOnly.body, /Hello Pat/);
  assert.match(htmlOnly.body, /See you & soon/);
  assert.doesNotMatch(htmlOnly.body, /<|>/);
  const attached = await parseEmail(rawEmail({ text: "See attached", attachment: { filename: "quote.txt", content: "SECRET PRICE LIST" } }));
  assert.equal(attached.body, "See attached");
});

test("parseEmail drops control characters, keeps line breaks, and caps the subject and the body", async () => {
  const email = await parseEmail(
    rawEmail({ subject: `Hi\u0007 there ${"s".repeat(400)}`, text: `a\u0000b\tc\u001b[31m\n\n\n\n\nd ${"x".repeat(6000)}` }),
  );
  assert.ok(email.subject.startsWith("Hi there "));
  assert.equal(email.subject.length, MAX_SUBJECT_CHARS);
  assert.ok(email.body.startsWith("abc[31m\n\nd "), JSON.stringify(email.body.slice(0, 20)));
  assert.equal(email.body.length, MAX_BODY_CHARS);
  assert.doesNotMatch(email.body, /[\u0000-\u0009\u000B-\u001F\u007F-\u009F]/);
});

test("untrustedText is the subject, a blank line and the body", async () => {
  const email = await parseEmail(rawEmail({ subject: "Next steps", text: "Thanks for the call.\n" }));
  assert.equal(untrustedText(email), "Subject: Next steps\n\nThanks for the call.");
  const noBody = await parseEmail(rawEmail({ subject: "Just the subject", text: "" }));
  assert.equal(untrustedText(noBody), "Subject: Just the subject");
});

test("messageKey: the Message-ID as given (trimmed, capped), or a sha256 of Date, From and Subject", async () => {
  assert.equal(await messageKey(await parseEmail(rawEmail({ messageId: "  <abc@mail.example.com>  " }))), "<abc@mail.example.com>");
  const long = await messageKey(await parseEmail(rawEmail({ messageId: `<${"m".repeat(400)}@mail.example.com>` })));
  assert.equal(long.length, MAX_MESSAGE_KEY_CHARS);

  const first = await messageKey(await parseEmail(rawEmail({ messageId: null, subject: "One" })));
  assert.match(first, /^sha256:[0-9a-f]{64}$/);
  assert.equal(await messageKey(await parseEmail(rawEmail({ messageId: null, subject: "One" }))), first, "same message, same key");
  assert.notEqual(await messageKey(await parseEmail(rawEmail({ messageId: null, subject: "Two" }))), first);
  assert.notEqual(
    await messageKey(await parseEmail(rawEmail({ messageId: null, subject: "One", date: "Thu, 19 Nov 2026 17:31:00 +0000" }))),
    first,
  );
});

test("occurredAt: the Date header when it is valid and not in the future, else now", async () => {
  const at = async (date: string) => occurredAt(await parseEmail(rawEmail({ date })), NOW);
  assert.equal(await at("Thu, 19 Nov 2026 17:30:00 +0000"), "2026-11-19T17:30:00.000Z");
  assert.equal(await at("Thu, 19 Nov 2026 09:30:00 -0800"), "2026-11-19T17:30:00.000Z");
  assert.equal(await at("Mon, 23 Nov 2026 09:00:00 +0000"), NOW.toISOString(), "future");
  assert.equal(await at("not a date"), NOW.toISOString(), "garbage");
});
