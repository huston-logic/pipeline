import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import type { ActivityRow, ContactRow, DealRow, TaskRow } from "../src/db/db.ts";
import { createTestDb, type SqliteD1 } from "../src/db/sqlite-d1.ts";
import { dayBoundsUtc, DEFAULT_TZ, localDate } from "../src/time.ts";
import { buildDevSeed, parseSeedArgs } from "./seed-dev.ts";

const NOW = new Date("2026-11-19T18:00:00.000Z"); // 10:00 in Los Angeles
const CONTACT_TYPES = new Set(["form", "email", "call", "meeting", "note"]);

async function seeded(now = NOW, tz = DEFAULT_TZ): Promise<SqliteD1> {
  const db = await createTestDb();
  db.exec(buildDevSeed(now, tz));
  return db;
}

async function rows<T>(db: SqliteD1, sql: string): Promise<T[]> {
  return (await db.prepare(sql).all<T>()).results;
}

test("the seed loads onto the defaults with clean foreign keys, and loading it twice adds nothing", async () => {
  const db = await seeded();
  assert.deepEqual(await rows(db, "PRAGMA foreign_key_check"), []);
  const counts = async () =>
    Promise.all(
      ["contacts", "deals", "activities", "tasks", "rules"].map((t) =>
        db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).first<number>("n"),
      ),
    );
  const first = await counts();
  db.exec(buildDevSeed(NOW, DEFAULT_TZ));
  assert.deepEqual(await counts(), first);
});

test("eight obviously fake contacts with fixed ids and example.com emails", async () => {
  const db = await seeded();
  const contacts = await rows<ContactRow>(db, "SELECT * FROM contacts ORDER BY id");
  assert.deepEqual(
    contacts.map((c) => c.id),
    ["01", "02", "03", "04", "05", "06", "07", "08"].map((n) => `ct_seed${n}`),
  );
  for (const contact of contacts) assert.match(contact.email ?? "", /@example\.com$/, contact.name);
  assert.ok(contacts.some((c) => c.name === "Pat Example"));
});

test("deals cover every open stage, with one won and one lost", async () => {
  const db = await seeded();
  const deals = await rows<DealRow & { kind: string }>(
    db,
    "SELECT d.*, s.kind FROM deals d JOIN stages s ON s.key = d.stage_key ORDER BY d.id",
  );
  assert.equal(deals.length, 8);
  assert.equal(deals[0]?.id, "dl_seed01");
  const open = await rows<{ key: string }>(db, "SELECT key FROM stages WHERE kind = 'open'");
  for (const { key } of open) assert.ok(deals.some((d) => d.stage_key === key && d.status === "open"), key);
  assert.deepEqual(
    deals.filter((d) => d.status !== "open").map((d) => [d.status, d.kind]),
    [
      ["won", "won"],
      ["lost", "lost"],
    ],
  );
  for (const deal of deals) assert.ok(deal.stage_entered_at <= NOW.toISOString(), deal.id);
});

test("tasks: overdue, due today, in the future, done, snoozed and one on a contact only", async () => {
  const db = await seeded();
  const tasks = await rows<TaskRow>(db, "SELECT * FROM tasks");
  const now = NOW.toISOString();
  const today = dayBoundsUtc(localDate(NOW, DEFAULT_TZ), DEFAULT_TZ);
  const open = tasks.filter((t) => t.done_at === null);
  assert.ok(open.some((t) => t.due_at !== null && t.due_at < today.start.toISOString()), "overdue");
  assert.ok(
    open.some((t) => t.due_at !== null && t.due_at >= now && t.due_at < today.end.toISOString()),
    "due later today",
  );
  assert.ok(open.some((t) => t.due_at !== null && t.due_at >= today.end.toISOString()), "future");
  assert.ok(tasks.some((t) => t.done_at !== null), "done");
  assert.ok(open.some((t) => t.snoozed_until !== null && t.snoozed_until > now), "snoozed");
  assert.ok(tasks.some((t) => t.deal_id === null && t.contact_id !== null), "contact only");
});

test("a task due today is still due later today when the seed is made late in the evening", async () => {
  const late = new Date("2026-11-20T07:30:00.000Z"); // 23:30 in Los Angeles
  const db = await seeded(late);
  const today = dayBoundsUtc(localDate(late, DEFAULT_TZ), DEFAULT_TZ);
  const due = await rows<TaskRow>(
    db,
    `SELECT * FROM tasks WHERE done_at IS NULL AND due_at >= '${late.toISOString()}'
       AND due_at < '${today.end.toISOString()}'`,
  );
  assert.equal(due.length, 1);
});

test("activities are in the past, and last_activity_at matches each deal's latest contact", async () => {
  const db = await seeded();
  const activities = await rows<ActivityRow>(db, "SELECT * FROM activities");
  for (const a of activities) assert.ok(a.occurred_at < NOW.toISOString(), a.id);
  const deals = await rows<DealRow>(db, "SELECT * FROM deals");
  for (const deal of deals) {
    const latest = activities
      .filter((a) => a.deal_id === deal.id && CONTACT_TYPES.has(a.type))
      .map((a) => a.occurred_at)
      .sort()
      .at(-1);
    assert.equal(deal.last_activity_at, latest ?? null, deal.id);
  }
  assert.ok(activities.some((a) => a.type === "stage_change" && a.data !== null));
});

test("exactly one form activity, whose untrusted text is an obvious fake", async () => {
  const db = await seeded();
  const forms = await rows<ActivityRow>(db, "SELECT * FROM activities WHERE untrusted_text IS NOT NULL");
  assert.equal(forms.length, 1);
  assert.equal(forms[0]?.type, "form");
  assert.match(forms[0]?.untrusted_text ?? "", /fake/i);
  const contact = await db.prepare("SELECT untrusted_fields FROM contacts WHERE id = ?").bind(forms[0]?.contact_id).first();
  assert.notEqual(contact?.untrusted_fields, "[]");
});

test("one active and one paused rule", async () => {
  const db = await seeded();
  const rules = await rows<{ id: string; active: number }>(db, "SELECT id, active FROM rules ORDER BY id");
  assert.deepEqual(rules, [
    { id: "ru_seed01", active: 1 },
    { id: "ru_seed02", active: 0 },
  ]);
});

test("one brief, for yesterday, with an outside line, so the cron still composes today's", async () => {
  const db = await seeded();
  const briefs = await rows<{ local_date: string; text: string; items: string; send_status: string }>(db, "SELECT * FROM briefs");
  assert.equal(briefs.length, 1);
  assert.equal(briefs[0]?.local_date, "2026-11-18");
  assert.match(briefs[0]?.text ?? "", /^Pipeline brief for Wednesday Nov 18\n/);
  const items = JSON.parse(briefs[0]?.items ?? "[]") as { section: string; untrusted: boolean }[];
  assert.deepEqual(
    items.map((item) => [item.section, item.untrusted]),
    [
      ["due_today", false],
      ["gone_quiet", false],
      ["new_lead", true],
    ],
  );
  assert.equal(briefs[0]?.send_status, "off: brief_enabled is off");
});

test("the same time and timezone give the same SQL; quotes are escaped", () => {
  assert.equal(buildDevSeed(NOW, DEFAULT_TZ), buildDevSeed(new Date(NOW), DEFAULT_TZ));
  assert.notEqual(buildDevSeed(NOW, DEFAULT_TZ), buildDevSeed(NOW, "UTC"));
  assert.match(buildDevSeed(NOW, DEFAULT_TZ), /Pat''s/);
});

test("parseSeedArgs needs --out and takes an optional --tz", () => {
  assert.deepEqual(parseSeedArgs(["--out", "x.sql"]), { out: "x.sql", tz: DEFAULT_TZ });
  assert.deepEqual(parseSeedArgs(["--out", "x.sql", "--tz", "UTC"]), { out: "x.sql", tz: "UTC" });
  assert.throws(() => parseSeedArgs([]), /--out/);
  assert.throws(() => parseSeedArgs(["--out", "x.sql", "--remote"]), /--remote/);
  assert.throws(() => parseSeedArgs(["--out", "x.sql", "--tz", "Mars/Base"]), /timezone/);
});

test("node scripts/seed-dev.ts --out <file> writes the seed", () => {
  const dir = mkdtempSync(join(tmpdir(), "seed-dev-"));
  try {
    const out = join(dir, "seed.sql");
    const script = fileURLToPath(new URL("./seed-dev.ts", import.meta.url));
    const run = spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", script, "--out", out], {
      encoding: "utf8",
    });
    assert.equal(run.status, 0, run.stderr);
    assert.match(readFileSync(out, "utf8"), /INSERT OR IGNORE INTO contacts/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
