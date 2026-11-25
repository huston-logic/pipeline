import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { publicRoutes } from "../src/board/routes.ts";
import type { ActivityRow, AuditRow, ContactRow, DealRow, ImportDraftRow, TaskRow } from "../src/db/db.ts";
import { createTestDb, type SqliteD1 } from "../src/db/sqlite-d1.ts";
import { UserError } from "../src/services/errors.ts";
import { listDealsFiltered } from "../src/services/read.ts";
import { previewRuleFor } from "../src/services/rules.ts";
import { dealsInView, peopleInView } from "../src/services/view-read.ts";
import { parseFilters, parseSort } from "../src/services/view-spec.ts";
import { listViews } from "../src/services/views.ts";
import { undoChange } from "../src/services/undo.ts";
import { addDays, dayBoundsUtc, DEFAULT_TZ, localDate, zonedToUtc } from "../src/time.ts";
import { periodOf } from "../src/services/time-read.ts";
import { buildDevSeed, devSeed, DEMO_BUSINESS_NAME, parseSeedArgs, SEED_DRAFT_EXPIRES } from "./seed-dev.ts";

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

const TABLES = ["field_defs", "contacts", "deals", "activities", "tasks", "rules", "briefs", "audit_log", "views"];

test("the seed loads onto the defaults with clean foreign keys, and loading it twice adds nothing", async () => {
  const db = await seeded();
  assert.deepEqual(await rows(db, "PRAGMA foreign_key_check"), []);
  const counts = async () =>
    Promise.all(TABLES.map((t) => db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).first<number>("n")));
  const first = await counts();
  assert.ok(first.every((n) => (n ?? 0) > 0), `every table has rows: ${first.join(", ")}`);
  db.exec(buildDevSeed(NOW, DEFAULT_TZ));
  assert.deepEqual(await counts(), first);
});

test("the local copy is named after the demo firm, unless the owner has named it already", async () => {
  const db = await seeded();
  assert.equal(await db.prepare("SELECT business_name FROM settings").first("business_name"), DEMO_BUSINESS_NAME);
  assert.match(DEMO_BUSINESS_NAME, /\(demo\)$/);
  const named = await createTestDb();
  named.exec("UPDATE settings SET business_name = 'My Firm'");
  named.exec(buildDevSeed(NOW, DEFAULT_TZ));
  assert.equal(await named.prepare("SELECT business_name FROM settings").first("business_name"), "My Firm");
});

test("15 to 20 made-up contacts at 8 to 12 companies, several with two or three people, on example domains", async () => {
  const db = await seeded();
  const contacts = await rows<ContactRow>(db, "SELECT * FROM contacts WHERE id LIKE 'ct_seed%' ORDER BY id");
  assert.ok(contacts.length >= 15 && contacts.length <= 20, `${contacts.length} contacts`);
  assert.equal(contacts[0]?.id, "ct_seed01");
  for (const contact of contacts) {
    // Only the campaign seed's skipped person (ct_seed19) has no address.
    if (contact.email !== null || contact.id !== "ct_seed19") assert.match(contact.email ?? "", /@example\.(com|org|net)$/, contact.name);
    assert.match(contact.phone ?? "", /^555-01\d\d$/, contact.name);
  }
  const companies = new Map<string, number>();
  for (const { business } of contacts) {
    const key = (business ?? "").trim().toLowerCase();
    if (key !== "") companies.set(key, (companies.get(key) ?? 0) + 1);
  }
  assert.ok(companies.size >= 8 && companies.size <= 12, `${companies.size} companies`);
  assert.ok([...companies.values()].filter((n) => n >= 2 && n <= 3).length >= 3, "several companies have 2 or 3 people");
  assert.ok(contacts.some((c) => c.business === null), "someone without a company");
  assert.ok(
    contacts.some((c) => c.business !== null && c.business !== c.business.trim()),
    "one company typed with stray spaces, to show the grouping",
  );
});

test("15 to 25 deals over every stage, open and closed, with realistic values", async () => {
  const db = await seeded();
  const deals = await rows<DealRow & { kind: string }>(
    db,
    "SELECT d.*, s.kind FROM deals d JOIN stages s ON s.key = d.stage_key ORDER BY d.id",
  );
  assert.ok(deals.length >= 15 && deals.length <= 25, `${deals.length} deals`);
  const stages = await rows<{ key: string; kind: string }>(db, "SELECT key, kind FROM stages");
  for (const { key } of stages) assert.ok(deals.some((d) => d.stage_key === key), key);
  for (const deal of deals) {
    assert.equal(deal.status, deal.kind, `${deal.id}: status follows the stage`);
    assert.ok(deal.stage_entered_at <= NOW.toISOString(), deal.id);
    if (deal.value !== null) assert.ok(deal.value >= 500 && deal.value <= 50_000, `${deal.id}: ${deal.value}`);
  }
  const one = deals.find((d) => d.id === "dl_seed01");
  assert.equal(one?.status, "open");
  assert.equal(one?.untrusted_fields, "[]", "dl_seed01 is a normal deal");
  assert.ok(one?.next_step && one.next_at && one.next_at > NOW.toISOString(), "dl_seed01 has an upcoming next step");
  const two = deals.find((d) => d.id === "dl_seed02");
  assert.deepEqual(JSON.parse(two?.untrusted_fields ?? "[]"), ["title"], "dl_seed02 came in through the website form");
  assert.ok(deals.some((d) => d.status === "open" && d.next_at !== null && d.next_at < NOW.toISOString()), "an overdue next step");
});

test("tasks: overdue, due later today, upcoming, done, snoozed and one on a contact only", async () => {
  const db = await seeded();
  const tasks = await rows<TaskRow>(db, "SELECT * FROM tasks");
  const now = NOW.toISOString();
  const today = dayBoundsUtc(localDate(NOW, DEFAULT_TZ), DEFAULT_TZ);
  const open = tasks.filter((t) => t.done_at === null);
  const awake = open.filter((t) => t.snoozed_until === null || t.snoozed_until <= now);
  assert.ok(awake.filter((t) => t.due_at !== null && t.due_at < today.start.toISOString()).length >= 2, "overdue");
  assert.ok(awake.some((t) => t.due_at !== null && t.due_at >= now && t.due_at < today.end.toISOString()), "due later today");
  assert.ok(open.some((t) => t.due_at !== null && t.due_at >= today.end.toISOString()), "upcoming");
  assert.ok(tasks.some((t) => t.done_at !== null), "done");
  assert.ok(open.some((t) => t.snoozed_until !== null && t.snoozed_until > now), "snoozed");
  assert.ok(tasks.some((t) => t.deal_id === null && t.contact_id !== null), "contact only");
});

test("what is due later today is still later today when the seed is made late in the evening", async () => {
  const late = new Date("2026-11-20T07:30:00.000Z"); // 23:30 in Los Angeles
  const db = await seeded(late);
  const today = dayBoundsUtc(localDate(late, DEFAULT_TZ), DEFAULT_TZ);
  const between = `>= '${late.toISOString()}' AND %s < '${today.end.toISOString()}'`;
  const tasks = await rows<TaskRow>(db, `SELECT * FROM tasks WHERE done_at IS NULL AND due_at ${between.replace("%s", "due_at")}`);
  assert.ok(tasks.length >= 1);
  const deals = await rows<DealRow>(db, `SELECT * FROM deals WHERE status = 'open' AND next_at ${between.replace("%s", "next_at")}`);
  assert.ok(deals.length >= 1);
});

test("activities are in the past, cover every type, and the deals' dates follow from them", async () => {
  const db = await seeded();
  const activities = await rows<ActivityRow>(db, "SELECT * FROM activities");
  for (const a of activities) assert.ok(a.occurred_at < NOW.toISOString(), a.id);
  for (const type of ["form", "email", "call", "meeting", "note", "stage_change"]) {
    assert.ok(activities.some((a) => a.type === type), type);
  }
  assert.ok(activities.some((a) => a.actor === "ai") && activities.some((a) => a.actor === "owner"));
  const deals = await rows<DealRow>(db, "SELECT * FROM deals");
  for (const deal of deals) {
    const own = activities.filter((a) => a.deal_id === deal.id).sort((a, b) => a.occurred_at.localeCompare(b.occurred_at));
    const latest = own.filter((a) => CONTACT_TYPES.has(a.type)).at(-1);
    assert.equal(deal.last_activity_at, latest?.occurred_at ?? null, `${deal.id}: last activity`);
    const move = own.filter((a) => a.type === "stage_change").at(-1);
    assert.equal(deal.stage_entered_at, move?.occurred_at ?? deal.created_at, `${deal.id}: stage entered`);
    if (move) assert.equal((JSON.parse(move.data ?? "{}") as { to?: string }).to, deal.stage_key, `${deal.id}: last move`);
    for (const a of own) assert.equal(a.contact_id, deal.contact_id, `${a.id}: the deal's contact`);
  }
  // A note on a contact alone counts for their open deals, so the seed only has one from before their deal existed.
  // A campaign's email is not a reach (ruling 8), so it may be later.
  for (const note of activities.filter((a) => a.deal_id === null && !(a.data ?? "").includes('"via":"campaign"'))) {
    for (const deal of deals.filter((d) => d.contact_id === note.contact_id)) {
      assert.ok(note.occurred_at < deal.created_at, `${note.id} predates ${deal.id}`);
    }
  }
});

test("exactly one form activity, on dl_seed02, whose outside text is an obvious fake", async () => {
  const db = await seeded();
  const forms = await rows<ActivityRow>(db, "SELECT * FROM activities WHERE untrusted_text IS NOT NULL");
  assert.equal(forms.length, 1);
  assert.equal(forms[0]?.type, "form");
  assert.equal(forms[0]?.deal_id, "dl_seed02");
  assert.match(forms[0]?.untrusted_text ?? "", /made-up test message/);
  const contact = await db.prepare("SELECT untrusted_fields FROM contacts WHERE id = ?").bind(forms[0]?.contact_id).first();
  assert.ok(JSON.parse(String(contact?.untrusted_fields)).includes("business"), "the company came from the form too");
});

test("custom fields: a contact Role and a deal Project type, used by the seeded rows", async () => {
  const db = await seeded();
  const defs = await rows<{ entity: string; key: string }>(db, "SELECT entity, key FROM field_defs ORDER BY entity");
  assert.deepEqual(defs, [
    { entity: "contact", key: "role" },
    { entity: "deal", key: "project_type" },
  ]);
  const types = await rows<{ t: string }>(db, "SELECT DISTINCT json_extract(fields, '$.project_type') AS t FROM deals WHERE t IS NOT NULL");
  const choices = JSON.parse(String(await db.prepare("SELECT choices FROM field_defs WHERE key = 'project_type'").first("choices")));
  for (const { t } of types) assert.ok(choices.includes(t), t);
});

test("only Grace's proposal sat three days without a reply, and only two open deals have gone quiet", async () => {
  const db = await seeded();
  const followup = await previewRuleFor(db, NOW, { type: "stage_followup", stage: "Proposal sent", days: 3 });
  assert.deepEqual([...new Set(followup.hits.map((hit) => hit.dealId))], ["dl_seed05"]);
  const quiet = await listDealsFiltered(db, { quiet: 5 }, NOW, DEFAULT_TZ);
  assert.deepEqual(quiet.map((deal) => deal.id).sort(), ["dl_seed05", "dl_seed06"]);
});

test("two active rules and one paused, one of them a lead_followup", async () => {
  const db = await seeded();
  const rules = await rows<{ id: string; active: number; type: string; params: string; created_by: string }>(
    db,
    "SELECT id, active, type, params, created_by FROM rules ORDER BY id",
  );
  assert.deepEqual(rules.map((r) => [r.id, r.active, r.type]), [
    ["ru_seed01", 1, "gone_quiet"],
    ["ru_seed02", 0, "stage_followup"],
    ["ru_seed03", 1, "lead_followup"],
  ]);
  assert.deepEqual(JSON.parse(rules[2]?.params ?? ""), { type: "lead_followup", status: "contacted", days: 5 });
  assert.equal(rules[2]?.created_by, "owner");
});

test("every person has a person status in step with their lead status, and one is a Partner (decision 0040)", async () => {
  const db = await seeded();
  const people = await rows<ContactRow>(db, "SELECT * FROM contacts ORDER BY id");
  for (const person of people) {
    const lead = person.lead_status !== null && person.lead_status !== "qualified";
    assert.equal(person.person_status === "lead", lead, `${person.id}: Lead exactly when an unqualified lead`);
    if (lead) assert.equal(person.sub_status, person.lead_status, `${person.id}: the sub-status is the lead status`);
  }
  assert.deepEqual(people.filter((p) => p.person_status === "partner").map((p) => p.id), ["ct_seed13"]);
  assert.equal(people.find((p) => p.id === "ct_lead12")?.person_status, "contact", "the qualified lead is a Contact");
});

test("twelve made-up leads across every status, on example domains, with reach, follow-ups and one imported", async () => {
  const db = await seeded();
  const leads = await rows<ContactRow>(db, "SELECT * FROM contacts WHERE id LIKE 'ct_lead%' ORDER BY id");
  assert.deepEqual(leads.map((l) => l.id), Array.from({ length: 12 }, (_, i) => `ct_lead${String(i + 1).padStart(2, "0")}`));
  assert.deepEqual([...new Set(leads.map((l) => l.lead_status))].sort(), ["bad", "contacted", "new", "not_a_fit", "not_now", "qualified"]);
  for (const lead of leads) {
    assert.match(lead.email ?? "", /@example\.(com|org|net)$/, lead.id);
    assert.match(lead.phone ?? "", /^555-01\d\d$/, lead.id);
    const age = (NOW.getTime() - new Date(lead.lead_status_at ?? "").getTime()) / 86_400_000;
    assert.ok(age >= 2 && age <= 40.5, `${lead.id}: status set ${age.toFixed(1)} days ago`);
  }
  const everyone = await rows<ContactRow>(db, "SELECT * FROM contacts WHERE lead_status IS NULL");
  assert.ok(everyone.length >= 15, "the people who are not leads are untouched");
  assert.equal(new Set((await rows<ContactRow>(db, "SELECT email FROM contacts")).map((c) => c.email?.toLowerCase())).size, leads.length + everyone.length);

  const imported = leads.filter((l) => JSON.parse(l.untrusted_fields).includes("name"));
  assert.equal(imported.length, 1, "one lead came from an import");
  const activities = await rows<ActivityRow>(db, "SELECT * FROM activities WHERE contact_id LIKE 'ct_lead%'");
  assert.ok(activities.some((a) => a.type === "note" && a.data === '{"via":"text"}'), "a text logged as a note");
  assert.ok(activities.some((a) => a.type === "note" && a.data === null), "a plain note");
  const checkBacks = await rows<TaskRow>(db, "SELECT * FROM tasks WHERE contact_id LIKE 'ct_lead%' AND deal_id IS NULL AND done_at IS NULL");
  assert.equal(checkBacks.length, 2);
  assert.ok(checkBacks.some((t) => (t.due_at ?? "") > NOW.toISOString()) && checkBacks.some((t) => (t.due_at ?? "") < NOW.toISOString()));
  const qualified = leads.filter((l) => l.lead_status === "qualified");
  for (const lead of qualified) {
    assert.ok((await rows(db, `SELECT id FROM deals WHERE contact_id = '${lead.id}'`)).length >= 1, "a qualified lead has a deal");
  }
  for (const lead of leads.filter((l) => l.lead_status !== "qualified")) {
    assert.deepEqual(await rows(db, `SELECT id FROM deals WHERE contact_id = '${lead.id}'`), [], `${lead.id}: no deal`);
  }
});

test("three board import drafts that never expire: matching, check and applied, with fake people only", async () => {
  const db = await seeded();
  const drafts = await rows<ImportDraftRow>(db, "SELECT * FROM import_drafts ORDER BY id");
  assert.deepEqual(drafts.map((d) => [d.id, d.expires_at, d.result === null, d.change_id]), [
    ["im_seed01", SEED_DRAFT_EXPIRES, true, null],
    ["im_seed02", SEED_DRAFT_EXPIRES, true, null],
    ["im_seed03", SEED_DRAFT_EXPIRES, false, "chg_seed00000016"],
  ]);
  assert.ok(await db.prepare("SELECT id FROM audit_log WHERE id = 'chg_seed00000016' AND tool = 'import'").first("id"));
  const parts = await rows<{ draft_id: string; text: string }>(db, "SELECT draft_id, text FROM import_draft_parts ORDER BY draft_id, seq");
  assert.deepEqual(parts.map((p) => p.draft_id), ["im_seed01", "im_seed02"], "an applied draft keeps no file");
  for (const { text } of parts) {
    for (const email of text.match(/[^\s,]+@[^\s,]+/g) ?? []) assert.match(email, /@example\.(com|org|net)$/);
  }
});

test("the leads rule would catch a contacted lead now", async () => {
  const db = await seeded();
  const preview = await previewRuleFor(db, NOW, { type: "lead_followup", status: "contacted", days: 5 });
  assert.deepEqual([...new Set(preview.hits.map((hit) => hit.contactId))].sort(), ["ct_lead03", "ct_lead04", "ct_lead11"]);
});

test("one brief, for yesterday, with an outside line, so the cron still composes today's", async () => {
  const db = await seeded();
  const briefs = await rows<{ local_date: string; text: string; items: string; sent_at: string | null; send_status: string }>(
    db,
    "SELECT * FROM briefs",
  );
  assert.equal(briefs.length, 1);
  assert.equal(briefs[0]?.local_date, "2026-11-18");
  assert.match(briefs[0]?.text ?? "", /^Pipeline brief for Wednesday Nov 18\n/);
  const items = JSON.parse(briefs[0]?.items ?? "[]") as { section: string; untrusted: boolean }[];
  assert.deepEqual([...new Set(items.map((item) => item.section))], ["overdue", "due_today", "gone_quiet", "new_lead"]);
  assert.ok(items.some((item) => item.untrusted));
  assert.equal(briefs[0]?.sent_at, null, "never emailed");
  assert.equal(briefs[0]?.send_status, "off: brief_enabled is off");
});

test("the change log: recent changes by the owner, the AI and the form, each summary naming its change id", async () => {
  const db = await seeded();
  const audit = await rows<AuditRow>(db, "SELECT * FROM audit_log ORDER BY at");
  assert.ok(audit.length >= 10, `${audit.length} changes`);
  const monthAgo = new Date(NOW.getTime() - 30 * 86_400_000).toISOString();
  for (const row of audit) {
    assert.match(row.id, /^chg_[a-z0-9]{12}$/);
    assert.ok(row.at > monthAgo && row.at < NOW.toISOString(), `${row.id}: in the last 30 days`);
    assert.ok(row.summary.endsWith(` (change ${row.id})`), row.summary);
  }
  assert.deepEqual([...new Set(audit.map((row) => row.actor))].sort(), ["ai", "owner", "system"]);
  const undone = audit.filter((row) => row.undone_at !== null);
  assert.equal(undone.length, 1);
  const undo = audit.find((row) => row.undo_of === undone[0]?.id);
  assert.equal(undo?.id, undone[0]?.undone_by, "the undo is logged too");
  // The form's change never quotes the outside name or company.
  const intake = audit.find((row) => row.tool === "intake");
  assert.doesNotMatch(intake?.summary ?? "", /Jamie|Lindqvist|Oak Hollow/);
});

test("every seeded change either undoes cleanly or is refused in plain English; the newest ones undo", async () => {
  const ids = (await rows<{ id: string }>(await seeded(), "SELECT id FROM audit_log ORDER BY at")).map((r) => r.id);
  const undoable: string[] = [];
  const refused = new Map<string, string>();
  for (const id of ids) {
    const db = await seeded();
    try {
      await undoChange({ db, now: NOW, actor: "owner", tool: "undo_change" }, id);
      undoable.push(id);
      assert.deepEqual(await rows(db, "PRAGMA foreign_key_check"), [], id);
    } catch (error) {
      assert.ok(error instanceof UserError, `${id}: ${String(error)}`);
      refused.set(id, error.message);
    }
  }
  const db = await seeded();
  const toolOf = async (id: string) => String(await db.prepare("SELECT tool FROM audit_log WHERE id = ?").bind(id).first("tool"));
  assert.deepEqual(
    (await Promise.all(undoable.map(toolOf))).sort(),
    [
      "add_campaign_draft", "add_campaign_draft", "add_lead", "add_rule", "add_rule", "add_task", "complete_task", "import", "intake", "log_activity", "log_activity",
      "pause_rule", "qualify_lead", "snooze_task", "update_contact", "update_contact", "update_deal",
    ],
  );
  // What each refused one answers, as the comments in seed-dev.ts and decision 0016 say.
  assert.deepEqual(
    [...refused.keys()].sort(),
    ["chg_seed00000003", "chg_seed00000006", "chg_seed00000007", "chg_seed00000013", "chg_seed00000022", "chg_seed00000023", "chg_seed00000024"],
  );
  assert.match(refused.get("chg_seed00000022") ?? "", /sending steps can't be undone/);
  assert.match(refused.get("chg_seed00000024") ?? "", /unsubscribe can't be undone/);
  assert.match(refused.get("chg_seed00000003") ?? "", /^Can't undo chg_seed00000003: other records now depend on it \(5 activities and 1 task\)/);
  assert.match(
    refused.get("chg_seed00000013") ?? "",
    /^Can't undo chg_seed00000013: deal "Foundations for three new fermentation tanks" changed since \(see recent_changes\)\./,
  );
  assert.match(refused.get("chg_seed00000006") ?? "", /^chg_seed00000006 was already undone \(by chg_seed00000007\)/);
  assert.match(refused.get("chg_seed00000007") ?? "", /^Undo entries can't be undone/);
});

test("the same time and timezone give the same SQL; quotes are escaped", () => {
  assert.equal(buildDevSeed(NOW, DEFAULT_TZ), buildDevSeed(new Date(NOW), DEFAULT_TZ));
  assert.notEqual(buildDevSeed(NOW, DEFAULT_TZ), buildDevSeed(NOW, "UTC"));
  assert.match(buildDevSeed(NOW, DEFAULT_TZ), /Dana''s call/);
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

test("two saved views (decision 0042): referrals, latest activity first, and open commercial jobs by value", async () => {
  const db = await seeded();
  const saved = (await listViews(db)).filter((view) => view.kind === "saved");
  assert.deepEqual(saved.map((view) => [view.id, view.name, view.path]), [
    ["vw_seed01", "Referrals", "/people?view=vw_seed01"],
    ["vw_seed02", "Commercial jobs", "/pipeline?view=vw_seed02"],
  ]);
  const row = async (id: string) => (await db.prepare("SELECT * FROM views WHERE id = ?").bind(id).first<{ filters: string; sort: string }>())!;
  const people = await row("vw_seed01");
  const referrals = await peopleInView(db, NOW, DEFAULT_TZ, parseFilters(people.filters), parseSort("people", people.sort));
  assert.ok(referrals.total >= 3, `${referrals.total} referrals`);
  const deals = await row("vw_seed02");
  const commercial = await dealsInView(db, NOW, DEFAULT_TZ, parseFilters(deals.filters), parseSort("deals", deals.sort));
  assert.deepEqual(commercial.items.map((deal) => deal.value), [18000, 6800, 4800, null], "open commercial jobs, highest value first");
});

/** The entry that keeps /time?week=2026-11-16 (a fixed route in boardRoutes) a populated past week. */
const FIXED_WEEK_ENTRY = "te_seed10";

test("one entry sits on a fixed date in the fixed route's week, whenever the seed is made", () => {
  const tz = "America/Los_Angeles";
  for (const now of [zonedToUtc("2026-11-24T09:00", tz), zonedToUtc("2027-03-02T09:00", tz)]) {
    const entry = devSeed(now, tz).timeEntries.find((row) => row.id === FIXED_WEEK_ENTRY);
    assert.ok(entry, `at ${now.toISOString()}`);
    assert.equal(entry.started_at, zonedToUtc("2026-11-17T10:00", tz).toISOString());
    assert.equal(entry.archived, 0);
    assert.ok(typeof entry.ended_at === "string" && typeof entry.minutes === "number" && entry.minutes > 0);
  }
});

test("the time entries sit in this week and the previous one, whatever day the seed is made (decision 0051)", () => {
  const tz = "America/Los_Angeles";
  const monday = "2026-11-16";
  const nows = [
    zonedToUtc(`${monday}T00:30`, tz),
    zonedToUtc("2026-11-18T12:00", tz),
    zonedToUtc("2026-11-22T23:30", tz),
  ];
  for (const now of nows) {
    const week = periodOf("this_week", now, tz);
    const last = { from: addDays(week.from, -7), to: addDays(week.from, -1) };
    const dates = devSeed(now, tz)
      .timeEntries.filter((row) => row.id !== "te_seed01" && row.id !== FIXED_WEEK_ENTRY)
      .map((row) => localDate(new Date(String(row.started_at)), tz));
    assert.equal(dates.length, 8);
    assert.ok(dates.filter((d) => d >= week.from && d <= week.to).length >= 3, `this week at ${now.toISOString()}`);
    assert.ok(dates.filter((d) => d >= last.from && d <= last.to).length >= 3, `last week at ${now.toISOString()}`);
    assert.equal(dates.filter((d) => d === week.from).length, 3, "three on this week's Monday");
  }
});

test("campaigns (decision 0053): a draft to Partners, a sent one with every kind of result, a draft to people picked", async () => {
  const db = await seeded();
  const campaigns = await rows<{ id: string; name: string; status: string }>(db, "SELECT id, name, status FROM campaigns ORDER BY id");
  assert.deepEqual(campaigns.map((c) => [c.id, c.name, c.status]), [
    ["cp_seed01", "Spring open house", "draft"],
    ["cp_seed02", "November newsletter", "sent"],
    ["cp_seed03", "Thank you to referrers", "draft"],
  ]);
  const step = await db.prepare("SELECT * FROM campaign_steps WHERE campaign_id = 'cp_seed01'").first<{ subject: string; body: string; button_label: string; button_url: string }>();
  assert.match(step?.subject ?? "", /\{\{first_name\}\}/);
  assert.equal((step?.body.match(/https:\/\//g) ?? []).length, 1);
  assert.deepEqual([step?.button_label, step?.button_url], ["RSVP", "https://example.com/rsvp"]);
  assert.ok(((await db.prepare("SELECT suggested_send_at AS at FROM campaigns WHERE id = 'cp_seed01'").first<{ at: string }>())?.at ?? "") > NOW.toISOString());
  const results = await rows<{ status: string; n: number }>(db, "SELECT status, COUNT(*) AS n FROM campaign_recipients WHERE campaign_id = 'cp_seed02' GROUP BY status ORDER BY status");
  assert.deepEqual(results.map((r) => [r.status, r.n]), [["bounced", 1], ["delivered", 3], ["skipped", 1]]);
  assert.equal(await db.prepare("SELECT COUNT(*) AS n FROM campaign_recipients WHERE unsubscribed_at IS NOT NULL").first("n"), 1);
  for (const row of await rows<{ unsub_token: string | null; email: string }>(db, "SELECT unsub_token, email FROM campaign_recipients")) {
    if (row.unsub_token !== null) assert.match(row.unsub_token, /^[A-Za-z0-9_-]{43}$/);
    assert.doesNotMatch(row.email, /@(?!example\.(com|org|net|test)$)/);
  }
  const blocks = await rows<{ reason: string; contact_id: string }>(db, "SELECT reason, contact_id FROM email_suppressions ORDER BY id");
  assert.deepEqual(blocks.map((b) => [b.reason, b.contact_id]), [["bounced", "ct_seed07"], ["unsubscribed", "ct_seed08"]]);
  const mails = await rows<ActivityRow>(db, "SELECT * FROM activities WHERE data LIKE '%\"via\":\"campaign\"%'");
  assert.equal(mails.length, 4);
  for (const mail of mails) assert.deepEqual([mail.type, mail.summary, mail.actor, mail.deal_id], ["email", "Campaign: November newsletter", "system", null]);
  const picked = await db.prepare("SELECT audience FROM campaigns WHERE id = 'cp_seed03'").first<{ audience: string }>();
  assert.equal((JSON.parse(picked?.audience ?? "{}") as { people: string[] }).people.length, 2);
});

test("publicRoutes: the unsubscribe page's token belongs to a delivered recipient of cp_seed02", async () => {
  const db = await seeded();
  const token = publicRoutes.find((path) => path !== "/unsubscribe/test")?.slice("/unsubscribe/".length);
  const row = await db
    .prepare("SELECT status, campaign_id FROM campaign_recipients WHERE unsub_token = ?")
    .bind(token ?? "")
    .first<{ status: string; campaign_id: string }>();
  assert.deepEqual([row?.status, row?.campaign_id], ["delivered", "cp_seed02"]);
});
