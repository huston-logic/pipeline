import assert from "node:assert/strict";
import { test } from "node:test";
import type { AuditRow, Db, PushSubscriptionRow } from "../db/db.ts";
import { openTestDb } from "../db/sqlite-d1.ts";
import type { Ctx } from "../services/change.ts";
import { UserError } from "../services/errors.ts";
import { undoChange } from "../services/undo.ts";
import { listLivePush, markPushGone, removePush, subscribePush } from "./subscriptions.ts";

const NOW = new Date("2026-11-19T15:00:00.000Z");
const owner = (db: Db, tool: string, now = NOW): Ctx => ({ db, now, actor: "owner", tool });
// Fake keys in the browser's formats: a 65-byte point starting 0x04 and a 16-byte secret, base64url.
const P256DH = `BA${"A".repeat(85)}`;
const AUTH = "A".repeat(22);
const sub = (n = 1) => ({ endpoint: `https://push.example.net/send/device-${n}`, p256dh: P256DH, auth: AUTH });

const rows = async (db: Db) => (await db.prepare("SELECT * FROM push_subscriptions ORDER BY created_at, id").all<PushSubscriptionRow>()).results;
const audit = async (db: Db, id: string) => db.prepare("SELECT * FROM audit_log WHERE id = ?").bind(id).first<AuditRow>();

test("subscribePush stores the subscription as one audited owner change named by id, never by endpoint", async () => {
  const db = await openTestDb();
  const result = await subscribePush(owner(db, "push_subscribe"), sub());
  assert.ok(result);
  const [row, ...others] = await rows(db);
  assert.equal(others.length, 0);
  assert.match(row?.id ?? "", /^ps_[a-z2-7]{12}$/);
  assert.equal(row?.endpoint, "https://push.example.net/send/device-1");
  assert.equal(row?.gone_at, null);
  assert.equal(result.summary, `Turned on notifications on one device (${row?.id}) (change ${result.changeId})`);
  const change = await audit(db, result.changeId);
  assert.equal(change?.actor, "owner");
  assert.equal(change?.tool, "push_subscribe");
  assert.equal(change?.target_table, "push_subscriptions");
  assert.doesNotMatch(change?.summary ?? "", /push\.example\.net/);
});

test("an endpoint that is already on is no change; one that was turned off comes back on as the same row", async () => {
  const db = await openTestDb();
  const first = await subscribePush(owner(db, "push_subscribe"), sub());
  assert.ok(first);
  assert.equal(await subscribePush(owner(db, "push_subscribe"), sub()), null, "already on");
  const [row] = await rows(db);
  assert.ok(row);
  await removePush(owner(db, "push_remove"), row.id);
  const again = await subscribePush(owner(db, "push_subscribe", new Date(NOW.getTime() + 60_000)), { ...sub(), auth: "B".repeat(22) });
  assert.ok(again);
  const [back, ...others] = await rows(db);
  assert.equal(others.length, 0);
  assert.equal(back?.id, row.id);
  assert.equal(back?.gone_at, null);
  assert.equal(back?.auth, "B".repeat(22), "the browser's new keys are kept");
  assert.equal(back?.version, 3);
});

test("subscribePush refuses anything but an https endpoint up to 1,000 characters and well-formed keys", async () => {
  const db = await openTestDb();
  const bad = [
    { ...sub(), endpoint: "http://push.example.net/x" },
    { ...sub(), endpoint: "javascript:alert(1)" },
    { ...sub(), endpoint: "not a url" },
    { ...sub(), endpoint: `https://push.example.net/${"a".repeat(1000)}` },
    { ...sub(), endpoint: "https://user:pass@push.example.net/x" },
    { ...sub(), endpoint: "" },
    { ...sub(), p256dh: "AAAA" },
    { ...sub(), p256dh: `BA${"A".repeat(84)}!` },
    // Not an uncompressed point (the first byte isn't 0x04).
    { ...sub(), p256dh: `AA${"A".repeat(85)}` },
    { ...sub(), auth: "A".repeat(21) },
    { ...sub(), auth: "A".repeat(23) + "=" },
  ];
  for (const input of bad) {
    await assert.rejects(subscribePush(owner(db, "push_subscribe"), input), UserError, JSON.stringify(input).slice(0, 80));
  }
  assert.equal((await rows(db)).length, 0);
  assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM audit_log").first<{ n: number }>())?.n, 0);
});

test("an endpoint of exactly 1,000 characters is accepted", async () => {
  const db = await openTestDb();
  const base = "https://push.example.net/";
  assert.ok(await subscribePush(owner(db, "push_subscribe"), { ...sub(), endpoint: base + "a".repeat(1000 - base.length) }));
});

test("removePush turns one device off as an audited change; a second time says it is already off", async () => {
  const db = await openTestDb();
  await subscribePush(owner(db, "push_subscribe"), sub(1));
  await subscribePush(owner(db, "push_subscribe"), sub(2));
  const [one, two] = await rows(db);
  assert.ok(one && two);
  const result = await removePush(owner(db, "push_remove"), one.id);
  assert.equal(result.summary, `Turned off notifications on one device (${one.id}) (change ${result.changeId})`);
  assert.equal((await audit(db, result.changeId))?.tool, "push_remove");
  assert.deepEqual((await listLivePush(db)).map((row) => row.id), [two.id]);
  await assert.rejects(removePush(owner(db, "push_remove"), one.id), /already off/);
  await assert.rejects(removePush(owner(db, "push_remove"), "ps_nosuchdevice"), /no device/i);
});

test("markPushGone is a system change from push_send; undo brings the device back", async () => {
  const db = await openTestDb();
  await subscribePush(owner(db, "push_subscribe"), sub());
  const [row] = await rows(db);
  assert.ok(row);
  const gone = await markPushGone({ db, now: NOW, actor: "system", tool: "push_send" }, row.id);
  assert.ok(gone);
  const change = await audit(db, gone.changeId);
  assert.equal(change?.actor, "system");
  assert.equal(change?.tool, "push_send");
  assert.match(change?.summary ?? "", /^Turned off notifications on one device \(ps_[a-z2-7]+\): the push service no longer accepts them/);
  assert.deepEqual(await listLivePush(db), []);
  assert.equal(await markPushGone({ db, now: NOW, actor: "system", tool: "push_send" }, row.id), null, "already gone: no change");

  const undone = await undoChange(owner(db, "undo_change"), gone.changeId);
  assert.match(undone.summary, /notifications on one device/);
  assert.doesNotMatch(undone.summary, /push\.example\.net/);
  assert.deepEqual((await listLivePush(db)).map((r) => r.id), [row.id]);
});

test("undoing a subscribe removes the row; undoing a remove turns the device back on", async () => {
  const db = await openTestDb();
  const on = await subscribePush(owner(db, "push_subscribe"), sub());
  assert.ok(on);
  const [row] = await rows(db);
  assert.ok(row);
  const off = await removePush(owner(db, "push_remove"), row.id);
  await undoChange(owner(db, "undo_change"), off.changeId);
  assert.deepEqual((await listLivePush(db)).map((r) => r.id), [row.id]);

  const db2 = await openTestDb();
  const fresh = await subscribePush(owner(db2, "push_subscribe"), sub());
  assert.ok(fresh);
  const undo = await undoChange(owner(db2, "undo_change"), fresh.changeId);
  assert.match(undo.summary, /^Undid chg_[a-z2-7]+: Removed notifications on one device \(ps_[a-z2-7]+\)/);
  assert.deepEqual(await rows(db2), []);
});
