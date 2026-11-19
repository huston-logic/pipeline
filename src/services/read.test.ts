import assert from "node:assert/strict";
import { test } from "node:test";
import { buildFixtureSeed } from "../../tests/helpers/fixture-seed.ts";
import type { Db } from "../db/db.ts";
import { createTestDb, openTestDb } from "../db/sqlite-d1.ts";
import { DEFAULT_TZ } from "../time.ts";
import type { Ctx } from "./change.ts";
import { updateDeal } from "./deals.ts";
import { UserError } from "./errors.ts";
import { addLead } from "./leads.ts";
import {
  contactDetail,
  type ContactSort,
  getChange,
  getDealBrief,
  listCompanies,
  listContacts,
  listDealsFiltered,
  pipelineSummary,
  recentChanges,
  searchContacts,
  stageCounts,
  whatsDue,
} from "./read.ts";
import { undoChange } from "./undo.ts";

const NOW = new Date("2026-11-19T18:00:00.000Z");
const TZ = DEFAULT_TZ;
const ids = (items: { id: string }[]) => items.map((item) => item.id);

async function seededDb(): Promise<Db> {
  const db = await createTestDb();
  db.exec(buildFixtureSeed(NOW, TZ));
  return db;
}

test("every read answers an empty database with empty lists and zero counts", async () => {
  const db = await openTestDb();
  const summary = await pipelineSummary(db, NOW, TZ);
  assert.deepEqual(
    summary.stages.map((s) => [s.key, s.count, s.value, s.deals.length]),
    [
      ["new_inquiry", 0, 0, 0],
      ["replied", 0, 0, 0],
      ["call_booked", 0, 0, 0],
      ["call_done", 0, 0, 0],
      ["proposal_sent", 0, 0, 0],
    ],
  );
  assert.deepEqual(summary.closed, { won: 0, lost: 0, not_now: 0 });
  assert.deepEqual(summary.open, { count: 0, value: 0 });
  assert.equal(summary.total, 0);

  assert.deepEqual(await whatsDue(db, NOW, TZ), {
    today: "2026-11-19",
    overdueTasks: [],
    todayTasks: [],
    overdueDeals: [],
    todayDeals: [],
  });
  assert.deepEqual(await searchContacts(db, "pat"), []);
  assert.deepEqual(await searchContacts(db, ""), []);
  assert.deepEqual(await listDealsFiltered(db, {}, NOW, TZ), []);
  assert.deepEqual(await listDealsFiltered(db, { due: "week", quiet: 3 }, NOW, TZ), []);
  assert.deepEqual(await recentChanges(db, new Date(0)), []);
  await assert.rejects(getDealBrief(db, "dl_nothing", TZ, NOW), UserError);
});

test("pipelineSummary counts and lists the open deals per stage, plus closed counts", async () => {
  const db = await seededDb();
  const summary = await pipelineSummary(db, NOW, TZ);
  assert.deepEqual(
    summary.stages.map((s) => [s.key, s.label, s.count, s.value, ids(s.deals)]),
    [
      ["new_inquiry", "New inquiry", 2, 0, ["dl_seed06", "dl_seed02"]],
      ["replied", "Replied", 1, 0, ["dl_seed03"]],
      ["call_booked", "Call booked", 1, 1500, ["dl_seed01"]],
      ["call_done", "Call done", 1, 2400, ["dl_seed04"]],
      ["proposal_sent", "Proposal sent", 1, 750, ["dl_seed05"]],
    ],
  );
  assert.deepEqual(summary.closed, { won: 1, lost: 1, not_now: 0 });
  assert.deepEqual(summary.open, { count: 6, value: 4650 });
  assert.equal(summary.total, 8);

  const pat = summary.stages[2]?.deals[0];
  assert.ok(pat);
  assert.equal(pat.title, "Website refresh for Example Plumbing");
  assert.equal(pat.contactName, "Pat Example");
  assert.equal(pat.nextStep, "Discovery call");
  assert.equal(pat.nextAt, "2026-11-21T22:00:00.000Z");
  assert.equal(pat.nextAtLocal, "Sat Nov 21, 2:00 PM");
  assert.equal(pat.overdue, false);
});

test("whatsDue splits overdue and today in the owner's timezone and skips done and snoozed tasks", async () => {
  const db = await seededDb();
  await db.prepare("UPDATE deals SET next_at = '2026-11-18T20:00:00.000Z' WHERE id = 'dl_seed03'").run();
  await db.prepare("UPDATE deals SET next_at = '2026-11-20T07:59:00.000Z' WHERE id = 'dl_seed02'").run();
  await db.prepare("UPDATE deals SET next_at = '2026-11-18T20:00:00.000Z' WHERE id = 'dl_seed07'").run();

  const due = await whatsDue(db, NOW, TZ);
  assert.equal(due.today, "2026-11-19");
  assert.deepEqual(ids(due.overdueTasks), ["tk_seed02"]);
  assert.deepEqual(ids(due.todayTasks), ["tk_seed01"]);
  assert.deepEqual(ids(due.overdueDeals), ["dl_seed03"], "won deals are not due");
  assert.deepEqual(ids(due.todayDeals), ["dl_seed02"], "11:59 PM local is still today");

  const task = due.overdueTasks[0];
  assert.equal(task?.title, "Send Casey the price sheet");
  assert.equal(task?.dealTitle, "Landscaping site with a quote form");
  assert.equal(task?.contactName, "Casey Placeholder");
  assert.equal(task?.dueAtLocal, "Wed Nov 18, 9:00 AM");
});

test("getDealBrief has the contact with untrusted_fields, the timeline newest first with untrusted_text, and open tasks", async () => {
  const db = await seededDb();
  const robin = await getDealBrief(db, "dl_seed02", TZ, NOW);
  assert.equal(robin.contact.name, "Robin Sample");
  assert.deepEqual(robin.contact.untrusted_fields, ["name", "email", "business"]);
  assert.equal(robin.stage.label, "New inquiry");
  const [form] = robin.timeline;
  assert.equal(form?.type, "form");
  assert.match(form?.untrusted_text ?? "", /fake test message/);

  const pat = await getDealBrief(db, "website refresh for example plumbing", TZ, NOW);
  assert.equal(pat.deal.id, "dl_seed01");
  assert.deepEqual(ids(pat.timeline), ["ac_seed04", "ac_seed03", "ac_seed02", "ac_seed01"]);
  assert.deepEqual(pat.timeline[0]?.data, { from: "replied", to: "call_booked" });
  assert.equal(pat.timeline[1]?.untrusted_text, null);
  assert.deepEqual(ids(pat.openTasks), ["tk_seed01"]);
  assert.deepEqual(pat.next, { step: "Discovery call", at: "2026-11-21T22:00:00.000Z", atLocal: "Sat Nov 21, 2:00 PM" });
  assert.deepEqual(pat.contact.untrusted_fields, []);

  const morgan = await getDealBrief(db, "dl_seed06", TZ, NOW);
  assert.deepEqual(ids(morgan.openTasks), ["tk_seed05"], "the contact's own tasks are included");
});

test("searchContacts matches name, email or business and lists each contact's deals", async () => {
  const db = await seededDb();
  const found = await searchContacts(db, "bakery");
  assert.deepEqual(ids(found), ["ct_seed02"]);
  assert.deepEqual(found[0]?.deals, [
    {
      id: "dl_seed02",
      title: "New website for Sample Bakery",
      stageLabel: "New inquiry",
      status: "open",
      untrusted_fields: ["title"],
    },
  ]);
  assert.deepEqual(ids(await searchContacts(db, "SAMPLE")), ["ct_seed07", "ct_seed02"]);
  assert.deepEqual(ids(await searchContacts(db, "jordan@example")), ["ct_seed04"]);
});

test("listContacts: every contact not archived, by name, with open deals, last activity and outside fields", async () => {
  const db = await seededDb();
  await db.prepare("UPDATE contacts SET archived = 1 WHERE id = 'ct_seed08'").run();
  // A note on the contact itself (no deal) counts as activity too.
  await db
    .prepare("INSERT INTO activities (id, contact_id, type, summary, occurred_at, actor) VALUES ('ac_x', 'ct_seed06', 'note', 'Left a voicemail', ?, 'owner')")
    .bind("2026-11-19T17:00:00.000Z")
    .run();
  const { contacts, total } = await listContacts(db, TZ);
  assert.deepEqual(ids(contacts), ["ct_seed07", "ct_seed03", "ct_seed04", "ct_seed06", "ct_seed01", "ct_seed02", "ct_seed05"]);
  assert.equal(total, 7);

  const pat = contacts.find((c) => c.id === "ct_seed01");
  assert.deepEqual(pat?.openDeals, [{ id: "dl_seed01", title: "Website refresh for Example Plumbing", untrusted_fields: [] }]);
  assert.equal(pat?.business, "Example Plumbing");
  assert.equal(pat?.lastActivityAt, "2026-11-17T18:15:00.000Z", "the stage change two days before");
  assert.equal(pat?.lastActivityAtLocal, "Tue Nov 17, 10:15 AM");

  const alex = contacts.find((c) => c.id === "ct_seed07");
  assert.deepEqual(alex?.openDeals, [], "a won deal is not open");
  assert.equal(contacts.find((c) => c.id === "ct_seed06")?.lastActivityAt, "2026-11-19T17:00:00.000Z");

  const robin = contacts.find((c) => c.id === "ct_seed02");
  assert.deepEqual(robin?.untrusted_fields, ["name", "business"]);
  assert.deepEqual(robin?.openDeals[0]?.untrusted_fields, ["title"]);
  assert.deepEqual(await listContacts(await openTestDb(), TZ), { contacts: [], total: 0 });
});

/** A contact row with the given fields, written straight to the database. */
async function addContact(db: Db, id: string, row: { name: string; business?: string | null; email?: string; phone?: string; untrusted?: string[]; archived?: number }) {
  await db
    .prepare("INSERT INTO contacts (id, name, business, email, phone, untrusted_fields, archived) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .bind(id, row.name, row.business ?? null, row.email ?? null, row.phone ?? null, JSON.stringify(row.untrusted ?? []), row.archived ?? 0)
    .run();
}

async function addDeal(db: Db, id: string, contactId: string, value: number | null, status = "open") {
  const stage = status === "open" ? "replied" : status;
  await db
    .prepare("INSERT INTO deals (id, contact_id, title, stage_key, value, status, stage_entered_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .bind(id, contactId, `Deal ${id}`, stage, value, status, "2026-11-01T17:00:00.000Z")
    .run();
}

test("listContacts searches name, email, phone and company, ignoring case, and counts the matches", async () => {
  const db = await seededDb();
  const found = async (query: string) => {
    const list = await listContacts(db, TZ, { query });
    assert.equal(list.total, list.contacts.length, query);
    return ids(list.contacts);
  };
  assert.deepEqual(await found("sample"), ["ct_seed07", "ct_seed02"], "name and company");
  assert.deepEqual(await found("BAKERY"), ["ct_seed02"]);
  assert.deepEqual(await found("casey@example"), ["ct_seed03"], "email");
  assert.deepEqual(await found("555-0104"), ["ct_seed04"], "phone");
  assert.deepEqual(await found("  pat  "), ["ct_seed01"], "trimmed");
  assert.deepEqual(await found("%"), [], "LIKE wildcards are plain text");
  assert.deepEqual(await found("_"), []);
  assert.equal((await found("")).length, 8, "an empty search lists everyone");
  assert.deepEqual(await found("nobody"), []);
});

test("listContacts sorts by name, company, open deals or last activity, either way, ties by name", async () => {
  const db = await seededDb();
  await addContact(db, "ct_nocompany", { name: "Dee Nocompany" });
  await addDeal(db, "dl_second", "ct_seed03", 100);
  const sorted = async (sort: ContactSort, dir: "asc" | "desc") => ids((await listContacts(db, TZ, { sort, dir })).contacts);
  const byName = ["ct_seed07", "ct_seed03", "ct_nocompany", "ct_seed04", "ct_seed06", "ct_seed01", "ct_seed02", "ct_seed08", "ct_seed05"];
  assert.deepEqual(await sorted("name", "asc"), byName);
  assert.deepEqual(await sorted("name", "desc"), [...byName].reverse());
  // Demo Hardware, Example Auto Repair, Example Plumbing, Fake Street Bikes, Placeholder..., Sample Bakery, Sample
  // Salon, Testcase Cafe; no company last either way.
  const byCompany = ["ct_seed06", "ct_seed08", "ct_seed01", "ct_seed04", "ct_seed03", "ct_seed02", "ct_seed07", "ct_seed05"];
  assert.deepEqual(await sorted("company", "asc"), [...byCompany, "ct_nocompany"]);
  assert.deepEqual(await sorted("company", "desc"), [...[...byCompany].reverse(), "ct_nocompany"]);
  const deals = await sorted("deals", "desc");
  assert.equal(deals[0], "ct_seed03", "two open deals come first");
  assert.deepEqual(deals.slice(-3), ["ct_seed07", "ct_nocompany", "ct_seed08"], "no open deals last, by name");
  assert.equal((await sorted("deals", "asc"))[0], "ct_seed07");
  const latest = await sorted("activity", "desc");
  assert.equal(latest[0], "ct_seed02", "the form came in yesterday");
  assert.deepEqual(latest.slice(-2), ["ct_nocompany", "ct_seed06"], "nothing logged goes last, by name");
  const oldest = await sorted("activity", "asc");
  assert.equal(oldest[0], "ct_seed08", "the lost deal's note, 15 days ago");
  assert.deepEqual(oldest.slice(-2), ["ct_nocompany", "ct_seed06"], "nothing logged goes last either way");
});

test("listContacts shows at most `limit` contacts and says how many matched", async () => {
  const db = await seededDb();
  const list = await listContacts(db, TZ, { limit: 3 });
  assert.deepEqual(ids(list.contacts), ["ct_seed07", "ct_seed03", "ct_seed04"]);
  assert.equal(list.total, 8);
  const search = await listContacts(db, TZ, { query: "sample", limit: 1 });
  assert.equal(search.contacts.length, 1);
  assert.equal(search.total, 2);
});

test("listCompanies groups contacts by company, ignoring case and spaces, with their open deals; no company last", async () => {
  const db = await createTestDb();
  await addContact(db, "ct_a", { name: "Ann Acme", business: "Acme Ltd" });
  await addContact(db, "ct_b", { name: "Bo Acme", business: "  acme   LTD " });
  await addContact(db, "ct_c", { name: "Cy Acme", business: "ACME LTD", untrusted: ["name", "business"] });
  await addContact(db, "ct_d", { name: "Di Beta", business: "Beta Co", untrusted: ["business"] });
  await addContact(db, "ct_e", { name: "Ed Solo" });
  await addContact(db, "ct_f", { name: "Fi Blank", business: "   " });
  await addContact(db, "ct_g", { name: "Gus Gone", business: "Acme Ltd", archived: 1 });
  await addDeal(db, "dl_a", "ct_a", 1000);
  await addDeal(db, "dl_b", "ct_b", 500);
  await addDeal(db, "dl_won", "ct_b", 9999, "won");
  await addDeal(db, "dl_d", "ct_d", null);
  await addDeal(db, "dl_g", "ct_g", 7);

  const { companies, noCompany } = await listCompanies(db, NOW, TZ);
  assert.deepEqual(
    companies.map((c) => [c.name, c.nameOutside, ids(c.contacts), c.openDealCount, c.openValue, ids(c.openDeals)]),
    [
      ["Acme Ltd", false, ["ct_a", "ct_b", "ct_c"], 2, 1500, ["dl_a", "dl_b"]],
      ["Beta Co", true, ["ct_d"], 1, 0, ["dl_d"]],
    ],
  );
  assert.deepEqual(companies[0]?.contacts[2]?.untrusted_fields, ["name"], "a contact's own outside name stays labelled");
  assert.deepEqual(ids(noCompany?.contacts ?? []), ["ct_e", "ct_f"]);
  assert.equal(noCompany?.openDealCount, 0);
  assert.deepEqual(await listCompanies(await openTestDb(), NOW, TZ), { companies: [], noCompany: null });
});

test("listCompanies shows a company typed only by outside forms with the label, and sorts companies by name", async () => {
  const db = await createTestDb();
  await addContact(db, "ct_z", { name: "Zed", business: "zeta works" });
  await addContact(db, "ct_y", { name: "Yan", business: "Alpha", untrusted: ["business"] });
  await addContact(db, "ct_x", { name: "Xi", business: "alpha" });
  const { companies } = await listCompanies(db, NOW, TZ);
  assert.deepEqual(
    companies.map((c) => [c.name, c.nameOutside]),
    [
      ["alpha", false],
      ["zeta works", false],
    ],
    "the trusted spelling wins over the outside one",
  );
});

test("listCompanies sorts by name ignoring case and accents, the way localeCompare in English does", async () => {
  const db = await createTestDb();
  const names = ["Zinc Works", "éclair bakery", "apple farm", "Banana Co", "Eagle Roofing", "ÁBACO"];
  for (const [i, business] of names.entries()) await addContact(db, `ct_s${i}`, { name: `Person ${i}`, business });
  const { companies } = await listCompanies(db, NOW, TZ);
  const expected = [...names].sort((a, b) => a.localeCompare(b, "en", { sensitivity: "base" }));
  assert.deepEqual(companies.map((c) => c.name), expected);
  assert.deepEqual(expected, ["ÁBACO", "apple farm", "Banana Co", "Eagle Roofing", "éclair bakery", "Zinc Works"]);
});

test("contactDetail: the contact, every deal they have, open tasks and one timeline newest first", async () => {
  const db = await seededDb();
  assert.equal(await contactDetail(db, "ct_nothing", TZ, NOW), null);

  const pat = await contactDetail(db, "ct_seed01", TZ, NOW);
  assert.ok(pat);
  assert.equal(pat.contact.name, "Pat Example");
  assert.deepEqual(ids(pat.deals), ["dl_seed01"]);
  assert.equal(pat.deals[0]?.stageLabel, "Call booked");
  assert.deepEqual(ids(pat.openTasks), ["tk_seed01"]);
  assert.deepEqual(ids(pat.timeline), ["ac_seed04", "ac_seed03", "ac_seed02", "ac_seed01"]);
  assert.equal(pat.timeline[0]?.dealId, "dl_seed01");
  assert.equal(pat.timelineMore, false);

  const alex = await contactDetail(db, "ct_seed07", TZ, NOW);
  assert.deepEqual(alex?.deals.map((d) => [d.id, d.status]), [["dl_seed07", "won"]], "closed deals are listed too");
  assert.deepEqual(ids(alex?.openTasks ?? []), [], "done tasks are left out");

  const morgan = await contactDetail(db, "ct_seed06", TZ, NOW);
  assert.deepEqual(ids(morgan?.openTasks ?? []), ["tk_seed05"], "a task on the contact alone");

  const robin = await contactDetail(db, "ct_seed02", TZ, NOW);
  assert.deepEqual(robin?.contact.untrusted_fields, ["name", "email", "business"]);
  assert.match(robin?.timeline[0]?.untrusted_text ?? "", /fake test message/);
  assert.deepEqual(robin?.deals[0]?.untrusted_fields, ["title", "contactName"]);

  await db
    .prepare("INSERT INTO activities (id, contact_id, type, summary, occurred_at, actor) VALUES ('ac_own', 'ct_seed01', 'note', 'Own note', ?, 'owner')")
    .bind("2026-11-19T17:00:00.000Z")
    .run();
  const again = await contactDetail(db, "ct_seed01", TZ, NOW);
  assert.equal(again?.timeline[0]?.id, "ac_own", "the contact's own notes are in the timeline");
  assert.equal(again?.timeline[0]?.dealId, null);
});

test("contactDetail names the deal of every timeline entry, archived deals included", async () => {
  const db = await seededDb();
  await db.prepare("UPDATE deals SET archived = 1 WHERE id = 'dl_seed01'").run();
  const pat = await contactDetail(db, "ct_seed01", TZ, NOW);
  assert.deepEqual(ids(pat?.deals ?? []), [], "archived deals are not listed as deals");
  assert.equal(pat?.timeline.length, 4);
  for (const item of pat?.timeline ?? []) {
    assert.deepEqual(item.deal, { id: "dl_seed01", title: "Website refresh for Example Plumbing", untrusted_fields: [], archived: true }, item.id);
  }
  const robin = await contactDetail(db, "ct_seed02", TZ, NOW);
  assert.deepEqual(robin?.timeline[0]?.deal, { id: "dl_seed02", title: "New website for Sample Bakery", untrusted_fields: ["title"], archived: false });
  await db
    .prepare("INSERT INTO activities (id, contact_id, type, summary, occurred_at, actor) VALUES ('ac_own', 'ct_seed01', 'note', 'Own note', ?, 'owner')")
    .bind("2026-11-19T17:00:00.000Z")
    .run();
  assert.equal((await contactDetail(db, "ct_seed01", TZ, NOW))?.timeline[0]?.deal, null, "a note on the contact alone");
});

test("contactDetail keeps the newest 50 timeline entries and says there are more", async () => {
  const db = await seededDb();
  for (let i = 0; i < 55; i++) {
    await db
      .prepare("INSERT INTO activities (id, contact_id, type, summary, occurred_at, actor) VALUES (?, 'ct_seed05', 'note', ?, ?, 'owner')")
      .bind(`ac_many${i}`, `Note ${i}`, new Date(Date.UTC(2026, 9, 1, 0, i)).toISOString())
      .run();
  }
  const detail = await contactDetail(db, "ct_seed05", TZ, NOW);
  assert.equal(detail?.timeline.length, 50);
  assert.equal(detail?.timelineMore, true);
});

test("listDealsFiltered filters by stage, status, due window and quiet days", async () => {
  const db = await seededDb();
  assert.equal((await listDealsFiltered(db, {}, NOW, TZ)).length, 8);
  assert.deepEqual(ids(await listDealsFiltered(db, { stage: "call booked" }, NOW, TZ)), ["dl_seed01"]);
  assert.deepEqual(ids(await listDealsFiltered(db, { status: "won" }, NOW, TZ)), ["dl_seed07"]);
  assert.deepEqual(ids(await listDealsFiltered(db, { due: "week" }, NOW, TZ)), ["dl_seed01", "dl_seed04"]);
  assert.deepEqual(ids(await listDealsFiltered(db, { due: "today" }, NOW, TZ)), []);
  assert.deepEqual(ids(await listDealsFiltered(db, { due: "overdue" }, NOW, TZ)), []);
  assert.deepEqual(ids(await listDealsFiltered(db, { quiet: 5 }, NOW, TZ)), ["dl_seed06", "dl_seed05"]);
  assert.deepEqual(ids(await listDealsFiltered(db, { quiet: 5, status: "won" }, NOW, TZ)), ["dl_seed07"]);
  const [item] = await listDealsFiltered(db, { stage: "call_done" }, NOW, TZ);
  assert.equal(item?.contactName, "Jordan Fake");
  assert.equal(item?.stageLabel, "Call done");
  assert.equal(item?.value, 2400);
  await assert.rejects(listDealsFiltered(db, { stage: "nowhere" }, NOW, TZ), /There's no stage "nowhere"/);
  await assert.rejects(listDealsFiltered(db, { quiet: 0 }, NOW, TZ), /whole number of days/);
});

test("recentChanges lists changes newest first with who, what and whether they were undone", async () => {
  const db = await openTestDb();
  const at = (iso: string, tool: string): Ctx => ({ db, now: new Date(iso), actor: "ai", tool });
  const lead = await addLead(at("2026-11-19T16:00:00.000Z", "add_lead"), { name: "Pat Example", dealTitle: "Site" });
  const move = await updateDeal(at("2026-11-19T17:00:00.000Z", "update_deal"), lead.dealId, { stage: "replied" });
  const undo = await undoChange(at("2026-11-19T17:30:00.000Z", "undo_change"), move.changeId);

  const changes = await recentChanges(db, new Date("2026-11-19T16:30:00.000Z"));
  assert.deepEqual(
    changes.map((c) => [c.changeId, c.tool, c.undone]),
    [
      [undo.changeId, "undo_change", false],
      [move.changeId, "update_deal", true],
    ],
  );
  assert.equal(changes[0]?.undoOf, move.changeId);
  assert.equal(changes[1]?.undoneBy, undo.changeId);
  assert.equal(changes[1]?.summary, move.summary);
  assert.equal(changes[1]?.actor, "ai");
  assert.equal(changes[1]?.at, "2026-11-19T17:00:00.000Z");
  assert.equal((await recentChanges(db, new Date(0))).length, 3);
});

test("getChange finds one change by id, whatever its age; an unknown id is null", async () => {
  const db = await openTestDb();
  const ctx: Ctx = { db, now: new Date("2020-01-01T00:00:00.000Z"), actor: "owner", tool: "add_lead" };
  const lead = await addLead(ctx, { name: "Pat Example" });
  const undo = await undoChange({ ...ctx, tool: "undo_change" }, lead.changeId);
  const change = await getChange(db, lead.changeId);
  assert.equal(change?.summary, lead.summary);
  assert.equal(change?.actor, "owner");
  assert.equal(change?.undone, true);
  assert.equal(change?.undoneBy, undo.changeId);
  assert.equal((await getChange(db, undo.changeId))?.undoOf, lead.changeId);
  assert.equal(await getChange(db, "chg_nothing0000"), null);
});

test("stageCounts counts the deals that are not archived in every stage, closed ones included", async () => {
  const db = await seededDb();
  const counts = await stageCounts(db);
  const open = (await pipelineSummary(db, NOW, TZ)).stages;
  for (const stage of open) assert.equal(counts.get(stage.key) ?? 0, stage.count, stage.key);
  assert.equal(counts.get("won"), 1);
  assert.equal(counts.get("lost"), 1);
  assert.equal(counts.get("not_now") ?? 0, 0);
});
