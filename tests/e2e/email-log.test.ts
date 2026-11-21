// Email logging end to end (decision 0031): a raw message posted to wrangler's local Email Routing route reaches the
// Worker's email() handler, which loads the MIME parser under workerd. Locally nothing prepends Cloudflare's
// Authentication-Results header: `message.headers` is read from the message itself, so its value is exactly the
// message's own headers and nothing is left once they are taken off the end. Even a message carrying a passing header
// is therefore dropped here, as `not_authenticated` after it was parsed. The logged path is covered by
// src/email/log.test.ts, which models the header Email Routing prepends in production.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { rawEmail } from "../helpers/fake-email.ts";
import { type DevServer, startDevServer } from "./harness.ts";

const OWNER = "owner@example.test";
// The fake address scripts/dev.mjs passes with --var.
const LOG = "log-dev@log.example.test";
// ct_seed07, Luis Ortega in the fake seed.
const CONTACT = "/contacts/ct_seed07";

let server: DevServer;

before(async () => {
  server = await startDevServer({ extraVars: [`OWNER_EMAILS:${OWNER}`] });
});

after(async () => {
  await server?.stop();
});

const deliver = (raw: string, from = OWNER) =>
  fetch(`${server.url}/cdn-cgi/local/email?${new URLSearchParams({ from, to: LOG })}`, { method: "POST", body: raw });

const message = (messageId: string, from = OWNER) =>
  rawEmail({
    from,
    to: "Luis Ortega <luis@example.com>",
    subject: "Storage quote, next steps",
    text: "Hi Luis,\nThe quote is attached.",
    messageId,
    auth: ["mx.cloudflare.net; spf=pass smtp.mailfrom=owner@example.test; dkim=pass header.d=example.test; dmarc=pass header.from=example.test"],
  });

const timeline = async () => (await (await fetch(`${server.url}${CONTACT}`)).text()).match(/Logged by BCC/g)?.length ?? 0;

const drops = (reason: string) => server.output().split(`"event":"email_log_dropped","reason":"${reason}"`).length - 1;

/** Waits up to 5 s for the Worker's log line to come through wrangler's output. */
async function dropped(reason: string, before: number): Promise<boolean> {
  for (let tries = 0; tries < 50; tries++) {
    if (drops(reason) > before) return true;
    await new Promise((done) => setTimeout(done, 100));
  }
  return false;
}

test("with nothing prepended by Cloudflare, an owner's email with a passing header of its own is parsed and dropped", async () => {
  assert.equal(await timeline(), 0);
  const before = drops("not_authenticated");
  const res = await deliver(message("<e2e-1@mail.example.test>"));
  assert.ok(res.status < 400, `local email route answered ${res.status}: ${await res.text()}`);
  assert.ok(await dropped("not_authenticated", before), `no not_authenticated drop logged:\n${server.output()}`);
  assert.doesNotMatch(server.output(), /email_log_failed/, "the parser loaded and read the message under workerd");
  assert.equal(await timeline(), 0);
});

test("mail from anyone else is dropped without a trace", async () => {
  const before = drops("not_owner");
  const res = await deliver(message("<e2e-2@mail.example.test>", "someone@example.net"), "someone@example.net");
  await res.text();
  assert.ok(await dropped("not_owner", before), `no not_owner drop logged:\n${server.output()}`);
  assert.equal(await timeline(), 0);
});
