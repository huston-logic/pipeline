import assert from "node:assert/strict";
import { test } from "node:test";
import { CLOUDFLARE_PASS, rawEmail } from "../../tests/helpers/fake-email.ts";
import {
  authPasses,
  htmlText,
  MAX_BODY_CHARS,
  MAX_MESSAGE_KEY_CHARS,
  MAX_SUBJECT_CHARS,
  messageKey,
  occurredAt,
  ownAuthResults,
  parseEmail,
  untrustedText,
} from "./parse.ts";

/** What `message.headers.get("authentication-results")` returns for these headers, top first: null for none, else the
 * values joined with ", " as the Headers object does. */
const joined = (values: readonly string[]): string | null => {
  if (values.length === 0) return null;
  const headers = new Headers();
  for (const value of values) headers.append("Authentication-Results", value);
  return headers.get("authentication-results");
};

/** As in production: Cloudflare's header (null for none) prepended to the message's own headers, which the raw text
 * holds too. */
const verdict = (cloudflare: string | null, own: readonly string[] = []): boolean =>
  authPasses(joined(cloudflare === null ? own : [cloudflare, ...own]), own);
const NOW = new Date("2026-11-20T18:00:00.000Z");

test("authPasses: Cloudflare's dmarc=pass, or with no dmarc result both spf=pass and dkim=pass (Ruling 3)", () => {
  assert.equal(verdict(CLOUDFLARE_PASS), true);
  assert.equal(verdict("mx.cloudflare.net; spf=pass smtp.mailfrom=owner@example.com; dkim=pass header.d=example.com"), true);
  assert.equal(verdict("mx.cloudflare.net; dmarc=pass header.from=example.com"), true);
  assert.equal(verdict("MX.Cloudflare.NET 1; DMARC=Pass (p=reject dis=none) header.from=example.com"), true);
  assert.equal(verdict("mx.cloudflare.net (the receiver); spf=pass; dkim=pass"), true);
  assert.equal(verdict("mx.cloudflare.net; spf=pass; dkim=none; dmarc=pass"), true, "dmarc=pass decides, as real mail shows");
  assert.equal(verdict("mx.cloudflare.net; spf=fail; dkim=pass; dmarc=pass"), true, "dmarc aligned through DKIM");
  assert.equal(verdict("mx.cloudflare.net; dmarc=pass (p=reject, sp=none) header.from=example.com"), true, "a comma in a comment");
  assert.equal(verdict('mx.cloudflare.net; spf=pass smtp.mailfrom="a,b"@example.com; dkim=pass'), true, "a comma in a quoted string");
});

test("authPasses: anything short of that is a fail", () => {
  assert.equal(verdict(null), false, "no header");
  assert.equal(authPasses(null, []), false, "no header at all");
  assert.equal(verdict("mx.cloudflare.net; none"), false, "no results");
  assert.equal(verdict("mx.cloudflare.net; spf=pass; dkim=pass; dmarc=fail"), false, "dmarc fail wins");
  assert.equal(verdict("mx.cloudflare.net; spf=pass; dkim=pass; dmarc=none"), false, "dmarc none");
  assert.equal(verdict("mx.cloudflare.net; spf=pass"), false, "spf alone");
  assert.equal(verdict("mx.cloudflare.net; dkim=pass"), false, "dkim alone");
  assert.equal(verdict("mx.cloudflare.net; spf=softfail; dkim=pass"), false, "spf softfail");
  assert.equal(verdict("mx.cloudflare.net; dmarc=pass; dmarc=fail"), false, "two dmarc results, one fails");
  assert.equal(verdict("mx.cloudflare.net; spf=pass; dkim=pass; dkim=fail"), false, "two dkim results, one fails");
  assert.equal(verdict("mail.example.net; spf=pass; dkim=pass; dmarc=pass"), false, "another receiver's verdict");
  assert.equal(verdict("mx.cloudflare.net.example.org; dmarc=pass"), false, "a look-alike authserv-id");
});

test("authPasses judges only Cloudflare's header: the Headers value less the message's own headers at its end", () => {
  const forged = "mx.cloudflare.net; spf=pass; dkim=pass; dmarc=pass";
  assert.equal(verdict("mx.cloudflare.net; spf=fail; dkim=none; dmarc=fail", [forged]), false, "Cloudflare's fail, forged pass after");
  assert.equal(verdict("mx.cloudflare.net; none", [forged]), false, "Cloudflare gave no results, forged pass after");
  assert.equal(verdict(CLOUDFLARE_PASS, [forged]), true, "Cloudflare's pass, another pass after");
  assert.equal(verdict(CLOUDFLARE_PASS, ["mail.example.net; dkim=fail", forged]), true, "Cloudflare's pass; later headers are not read");
  assert.equal(
    verdict("mx.cloudflare.net; spf=pass; dkim=fail", ["mx.cloudflare.net; dmarc=pass"]),
    false,
    "a forged dmarc=pass can't stand in for Cloudflare's missing dmarc result",
  );
  assert.equal(verdict("mail.example.net; dmarc=pass", ["mx.cloudflare.net; dmarc=fail"]), false, "another receiver's header first");
});

test("authPasses fails when the Headers value isn't Cloudflare's header followed by exactly the message's own", () => {
  assert.equal(verdict(null, [CLOUDFLARE_PASS]), false, "nothing prepended: the Headers value is just the message's own");
  assert.equal(verdict(null, [CLOUDFLARE_PASS, CLOUDFLARE_PASS]), false, "two of the message's own, nothing prepended");
  assert.equal(authPasses(joined([CLOUDFLARE_PASS]), ["mail.example.net; dmarc=fail"]), false, "the message's own header is missing");
  assert.equal(
    authPasses(joined([CLOUDFLARE_PASS, "mail.example.net; dkim=pass"]), ["mail.example.net; dkim=fail"]),
    false,
    "a suffix that doesn't match the raw text",
  );
  assert.equal(
    authPasses(joined([CLOUDFLARE_PASS, "a", "b"]), ["b", "a"]),
    false,
    "the message's own headers in another order",
  );
  assert.equal(authPasses(joined(["x", CLOUDFLARE_PASS]), [CLOUDFLARE_PASS]), false, "what is left isn't Cloudflare's");
});

test("authPasses: a sender's value with an unbalanced ( or \" in Cloudflare's header can't splice in a later header", () => {
  const paren = "mx.cloudflare.net; dkim=fail header.d=evil(.example; dmarc=fail header.from=example.com";
  assert.equal(verdict(paren, ["x) ; dmarc=pass"]), false, "the reviewer's comment splice");
  const quote = 'mx.cloudflare.net; dkim=fail header.d=evil".example; dmarc=fail header.from=example.com';
  assert.equal(verdict(quote, ['x" ; dmarc=pass']), false, "the reviewer's quote splice");
  const swallowed = "mx.cloudflare.net; spf=pass; dkim=pass header.d=evil(.example; dmarc=fail header.from=example.com";
  assert.equal(verdict(swallowed), false, "an unclosed comment that would hide Cloudflare's own dmarc=fail");
  assert.equal(verdict(swallowed.replace("(", '"')), false, "an unclosed quoted string likewise");
});

test("authPasses: a top-level comma left in Cloudflare's header means the subtraction went wrong, so it fails", () => {
  // As when the raw text holds one Authentication-Results header fewer than the Headers object.
  assert.equal(
    authPasses(joined(["mx.cloudflare.net; spf=pass; dkim=fail", "mx.cloudflare.net; dmarc=pass"]), []),
    false,
  );
  assert.equal(authPasses(joined([CLOUDFLARE_PASS, "mx.cloudflare.net; dmarc=pass"]), []), false);
});

test("authPasses compares the message's own headers with folding whitespace evened out", () => {
  const folded = "mail.example.net;\tspf=pass  smtp.mailfrom=owner@example.com";
  assert.equal(authPasses(joined([CLOUDFLARE_PASS, "mail.example.net; spf=pass smtp.mailfrom=owner@example.com"]), [folded]), true);
});

test("authPasses fails when a ; sits inside a comment or quoted string: only such a comment can hide a result", () => {
  assert.equal(verdict('mx.cloudflare.net; spf=fail smtp.mailfrom="x;dmarc=pass"@example.com; dkim=fail'), false);
  assert.equal(verdict("mx.cloudflare.net; spf=fail (; dmarc=pass) smtp.mailfrom=owner@example.com"), false);
  assert.equal(verdict("mx.cloudflare.net; spf=pass (nested (; dmarc=fail)) ; dkim=pass"), false);
  assert.equal(verdict('mx.cloudflare.net; spf=pass smtp.mailfrom="a;b"@example.com; dkim=pass'), false, "even a harmless one");
  // The reviewer's variant 2: two sender values (a DKIM domain and a HELO name) that close the comment between them,
  // inside Cloudflare's own header, hiding its dmarc=fail and adding a dmarc=pass.
  const variant2 =
    "mx.cloudflare.net; spf=pass smtp.mailfrom=owner@example.com; dkim=pass header.d=evil(; dmarc=fail header.from=example.com; smtp.helo=x) ; dmarc=pass";
  assert.equal(verdict(variant2), false, "variant 2");
  assert.equal(verdict(variant2, ["mail.example.net; dkim=pass"]), false, "variant 2 with a header of the message's own");
  // The only ; inside is escaped by the sender's trailing backslash.
  const escaped = "mx.cloudflare.net; spf=pass; dkim=pass header.d=evil(\\; dmarc=fail header.from=x) ; dmarc=pass";
  assert.equal(verdict(escaped), false, "an escaped ; in a comment");
  assert.equal(verdict(escaped.replace("evil(", 'evil"').replace("x)", 'x"')), false, "an escaped ; in a quoted string");
  assert.equal(verdict("mx.cloudflare.net; dmarc=pass (p=reject, sp=none) header.from=example.com"), true, "a comment with no ;");
});

test("ownAuthResults lists the message's own Authentication-Results values, top first, a spaced name included", async () => {
  const raw = rawEmail({ auth: ["mail.example.net; dkim=pass", "mx.cloudflare.net;\r\n\tdmarc=pass"] });
  const email = await parseEmail(`Authentication-Results : mail.example.org; spf=none\r\n${raw}`);
  assert.deepEqual(ownAuthResults(email), ["mail.example.org; spf=none", "mail.example.net; dkim=pass", "mx.cloudflare.net;\tdmarc=pass"]);
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
  assert.deepEqual(email.headers.filter((h) => h.key === "subject"), [{ key: "subject", value: "Next steps" }]);
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

test("htmlText drops script and style blocks, an unclosed one to the end, and keeps the words", () => {
  assert.equal(
    htmlText("<p>Hello <b>Pat</b></p><SCRIPT>alert(1)</script><p>See you &amp; soon</p><style>p{}</style>Bye"),
    "Hello Pat\nSee you & soon\nBye",
  );
  assert.equal(htmlText("<p>Kept</p><script>never closed <p>gone</p>"), "Kept\n");
});

test("htmlText finds script tags on the text as given: a letter that grows when lower-cased doesn't shift them", () => {
  // "İ".toLowerCase() is two UTF-16 units, so positions from a lower-cased copy land one unit late per İ.
  assert.equal(htmlText("İ<script>secret</script>Kept"), "İKept");
  assert.equal(htmlText("İİİ<STYLE>p{}</Style><p>Kept</p><Script>x</SCRIPT>"), "İİİKept\n");
});

test("htmlText can't rebuild a tag from the pieces of nested ones (CodeQL js/incomplete-multi-character-sanitization)", () => {
  for (const html of [
    "<scr<b>ipt>alert(1)</scr<b>ipt>",
    "<<b>script>alert(1)<</b>/script>",
    "<sc<i></i>ript src=x>",
    "<img<b> src=x onerror=alert(1)>",
    "<!<!-- x -->-- hidden -->",
    "<<b>script>alert(1)<</b>/script>",
    "<?<b>xml?>",
  ]) {
    assert.doesNotMatch(htmlText(html), /</, html);
  }
});

test("htmlText keeps a < that is text, as a browser does, and drops one that starts a tag", () => {
  assert.equal(htmlText("<p>I am < 5 min away. Call me</p>"), "I am < 5 min away. Call me\n");
  assert.equal(htmlText("x < y <b>bold</b> and 3<4"), "x < y bold and 3<4");
  assert.equal(htmlText("a < b and c <d"), "a < b and c ");
  assert.equal(htmlText("ends with <"), "ends with ");
  assert.equal(htmlText("<<b>script>"), "script>");
});

test("htmlText: a < left in the text is never followed by a tag start (seeded fuzz, 5,000 inputs)", () => {
  // With no "&" in the input, any "<" in the output is one the walk kept as text, so it must be followed by a
  // character that cannot open a tag (not a letter, "/", "!", "?" or another "<") and never end the text.
  const alphabet = ["<", ">", "/", "!", "?", "-", "s", "c", "r", "i", "p", "t", "b", " ", "=", '"', "5", "\n"];
  let seed = 0x5eed;
  // 32-bit LCG kept exact with Math.imul; its low bits repeat quickly, so the high ones pick the characters.
  const next = () => (seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) >>> 16;
  for (let n = 0; n < 5000; n++) {
    let html = "";
    for (let length = next() % 40; length > 0; length--) html += alphabet[next() % alphabet.length];
    assert.doesNotMatch(htmlText(html), /<(?:[a-z/!?<]|$)/i, JSON.stringify(html));
  }
});

test("htmlText decodes each entity once: &amp;lt; is the text &lt;, and &lt;b&gt; is the visible text <b>", () => {
  assert.equal(htmlText("&amp;lt;script&amp;gt;"), "&lt;script&gt;");
  assert.equal(htmlText("<p>5 &lt; 6 &amp;&amp; &quot;x&quot; &#39;y&#39;&nbsp;z</p>"), "5 < 6 && \"x\" 'y' z\n");
  assert.equal(htmlText("&lt;b&gt;bold?&lt;/b&gt;"), "<b>bold?</b>");
});

test("htmlText turns <br> and the end of a block into a line break", () => {
  assert.equal(htmlText("a<br>b<BR/>c<br />d</p>e</DIV>f</li>g</tr>h</h2>i<b>j</b>"), "a\nb\nc\nd\ne\nf\ng\nh\nij");
});

test("the HTML strip is linear: 20,000 characters of unclosed tags take well under 50 ms each", () => {
  for (const unit of ["<b", "<script", "<style", "<script>", "<br ", "<script></script>", "<style></style>", "<", "<scr<b>ipt>"]) {
    const html = unit.repeat(Math.ceil(20_000 / unit.length)).slice(0, 20_000);
    const started = performance.now();
    htmlText(html);
    const ms = performance.now() - started;
    assert.ok(ms < 50, `${unit}: ${ms.toFixed(1)} ms`);
  }
});

test("a 1 MB HTML-only body of unclosed tags is parsed and capped", async () => {
  const email = await parseEmail(rawEmail({ html: `<p>Hello</p>${"<b".repeat(500_000)}` }));
  assert.ok(email.body.startsWith("Hello"));
  assert.ok(email.body.length <= MAX_BODY_CHARS);
});

test("parseEmail drops control characters, keeps line breaks, and caps the subject and the body", async () => {
  const email = await parseEmail(
    rawEmail({ subject: `Hi\u0007 there ${"s".repeat(400)}`, text: `a\u0000b\tc\u001b[31m\n\n\n\n\nd ${"x".repeat(6000)}` }),
  );
  assert.ok(email.subject.startsWith("Hi there "));
  assert.equal(email.subject.length, MAX_SUBJECT_CHARS);
  // A tab becomes a space; the other control characters go.
  assert.ok(email.body.startsWith("ab c[31m\n\nd "), JSON.stringify(email.body.slice(0, 20)));
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
