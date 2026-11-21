import assert from "node:assert/strict";
import { test } from "node:test";
import { vapidHeaders, vapidKeys } from "../src/push/vapid.ts";
import { main, makeVapidKeys } from "./make-vapid-keys.mjs";
import { UsageError } from "./cli-args.mjs";

test("makeVapidKeys makes a pair the Worker accepts and can sign with", async () => {
  const { publicKey, privateKey } = await makeVapidKeys();
  assert.match(publicKey, /^B[A-Za-z0-9_-]{86}$/, "65 bytes, starting 0x04");
  assert.match(privateKey, /^[A-Za-z0-9_-]{43}$/, "32 bytes");
  const keys = vapidKeys({ VAPID_PUBLIC_KEY: publicKey, VAPID_PRIVATE_KEY: privateKey, VAPID_SUBJECT: "mailto:owner@example.com" });
  assert.ok(keys);
  const headers = await vapidHeaders("https://push.example.net/x", keys, new Date("2026-11-19T15:00:00.000Z"));
  assert.match(headers.Authorization, /^vapid t=/);
});

test("main prints the three secret commands for the copy, with fresh values, and writes nothing", async () => {
  const lines = [];
  await main(["--copy", "acme", "--subject", "mailto:owner@example.com"], (line) => lines.push(line));
  const commands = lines.filter((line) => line.startsWith("npx "));
  assert.deepEqual(commands, [
    "npx wrangler secret put VAPID_PUBLIC_KEY -c .copies/acme/wrangler.jsonc",
    "npx wrangler secret put VAPID_PRIVATE_KEY -c .copies/acme/wrangler.jsonc",
    "npx wrangler secret put VAPID_SUBJECT -c .copies/acme/wrangler.jsonc",
  ]);
  const pastes = lines.filter((line) => line.startsWith("  paste: ")).map((line) => line.slice(9));
  assert.equal(pastes.length, 3);
  assert.match(pastes[0], /^B[A-Za-z0-9_-]{86}$/);
  assert.match(pastes[1], /^[A-Za-z0-9_-]{43}$/);
  assert.equal(pastes[2], "mailto:owner@example.com");

  const again = [];
  await main(["--copy", "acme", "--subject", "https://example.com/contact"], (line) => again.push(line));
  assert.notEqual(again.find((line) => line.startsWith("  paste: B")), lines.find((line) => line.startsWith("  paste: B")), "a new pair each run");
  assert.ok(again.includes("  paste: https://example.com/contact"));
});

test("main refuses a missing copy name, and a missing subject or one that isn't mailto: or https:", async () => {
  await assert.rejects(main(["--subject", "mailto:owner@example.com"], () => {}), UsageError);
  await assert.rejects(main(["--copy", "../x", "--subject", "mailto:owner@example.com"], () => {}), UsageError);
  for (const argv of [["--copy", "acme"], ["--copy", "acme", "--subject", "owner@example.com"], ["--copy", "acme", "--subject", "http://example.com"]]) {
    await assert.rejects(main(argv, () => {}), { name: "Error", message: /starting with mailto: or https:\/\// }, argv.join(" "));
  }
});
