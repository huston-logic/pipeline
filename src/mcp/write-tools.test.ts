import assert from "node:assert/strict";
import { test } from "node:test";
import { buildFixtureSeed } from "../../tests/helpers/fixture-seed.ts";
import { approved, CHANGE_LINE, connectInMemory, fails, ok, okText } from "../../tests/helpers/mcp-client.ts";
import { createTestDb } from "../db/sqlite-d1.ts";
import { DEFAULT_TZ } from "../time.ts";
import { createMcpServer } from "./server.ts";

const NOW = new Date("2026-11-19T18:00:00.000Z");

async function setup() {
  const db = await createTestDb();
  db.exec(buildFixtureSeed(NOW, DEFAULT_TZ));
  return { db, c: await connectInMemory(createMcpServer({ db, now: () => NOW })) };
}

const changeIdOf = (data: unknown) => (data as { changeId: string }).changeId;

test("add_deal, after the owner's yes, writes one change whose line ends with its change id; the list shows the new ids", async () => {
  const { c } = await setup();
  const answer = await approved(c, "add_deal", {
    name: "Lee Example",
    email: "lee@example.com",
    source: "trade fair",
    notes: "Wants a quote for a new website.",
    nextStep: "Send a quote",
    nextAt: "2026-11-20T09:00",
  });
  assert.match(answer.headline, /^Added contact Lee Example with deal "Lee Example inquiry" in New inquiry; next: Send a quote, Fri Nov 20, 9:00 AM/);
  assert.match(answer.headline, CHANGE_LINE);
  const data = answer.data as { changeId: string; contactId: string; dealId: string };
  assert.ok(answer.headline.endsWith(`(change ${data.changeId})`));
  assert.match(data.contactId, /^ct_/);
  assert.match(data.dealId, /^dl_/);
  const { list } = answer.proposed.data as { list: { add: { id: string }[] } };
  assert.deepEqual(list.add.map((item) => item.id), [data.contactId, data.dealId], "a new person, not one on file");

  const brief = (await ok(c, "get_deal", { deal: data.dealId })).data as { next: { at: string } };
  assert.equal(brief.next.at, "2026-11-20T17:00:00.000Z");
});

test("add_deal with a contact adds a deal for that contact, with no name or email needed", async () => {
  const { db, c } = await setup();
  const answer = await approved(c, "add_deal", { contact: "ct_seed07", dealTitle: "Gift card page" });
  assert.match(answer.headline, /^Added deal "Gift card page" for existing contact Alex Sample in New inquiry/);
  const { list } = answer.proposed.data as { list: { add: { id: string }[] } };
  const dealId = (answer.data as { dealId: string }).dealId;
  assert.deepEqual(list.add.map((item) => item.id), [dealId], "no new person");
  assert.equal(await db.prepare("SELECT contact_id FROM deals WHERE id = ?").bind(dealId).first("contact_id"), "ct_seed07");
  assert.match(await fails(c, "add_deal", {}), /^A new deal needs a person: give their name, or an existing contact\.$/);
});

test("add_lead adds a person with status New and no deal; add_deal for that lead makes them Qualified", async () => {
  const { db, c } = await setup();
  const deals = async () => (await db.prepare("SELECT COUNT(*) AS n FROM deals").first<{ n: number }>())?.n;
  const before = await deals();
  const answer = await approved(c, "add_lead", { business: "Acme Plumbing", source: "drove past", contactFields: {} });
  assert.match(answer.headline, /^Added lead Acme Plumbing \(New\), from drove past \(change chg_[a-z0-9]{12}\)$/);
  const data = answer.data as { changeId: string; contactId: string; dealId?: string };
  assert.match(data.contactId, /^ct_/);
  assert.equal(data.dealId, undefined);
  assert.equal(await deals(), before, "no deal");

  assert.match(await fails(c, "add_lead", { name: "Jo Example", business: " acme  plumbing" }), /already has that business\. Say allowDuplicate: true/);
  await approved(c, "add_lead", { name: "Jo Example", business: " acme  plumbing", allowDuplicate: true });
  assert.match(
    await fails(c, "add_lead", { name: "Pat", email: "pat@example.com" }),
    /^Pat Example \(ct_seed01, pat@example\.com\) already uses that email\. Give them a lead status with update_contact, or use add_deal if they want something\.$/,
  );

  const qualified = await approved(c, "add_deal", { contact: data.contactId, dealTitle: "New van graphics" });
  assert.match(qualified.headline, /; Acme Plumbing is now Qualified \(change/);
});

test("update_contact sets a lead status, and Not now with a followUpDate adds the check-back task", async () => {
  const { c } = await setup();
  const lead = (await approved(c, "add_lead", { name: "Lee Example" })).data as { contactId: string };
  const answer = await approved(c, "update_contact", { contact: lead.contactId, leadStatus: "not_now", followUpDate: "2026-12-04" });
  assert.match(answer.headline, /^Updated Lee Example: lead status to Not now; added task "Check back with Lee Example", due Fri Dec 4 \(change chg_[a-z0-9]{12}\)$/);
  assert.match(await fails(c, "update_contact", { contact: lead.contactId, leadStatus: "qualified" }), /^Use qualify_lead to make a lead a contact/);
  assert.match(await fails(c, "update_contact", { contact: lead.contactId, leadStatus: "cold" }), /"leadStatus" must be one of: new, contacted, not_now, not_a_fit, bad, qualified/);
  assert.match(await fails(c, "update_contact", { contact: "ct_seed01", leadStatus: "contacted" }), /^Pat Example has 1 open deal\. Use return_to_lead on that deal instead/);
});

test("return_to_lead and qualify_lead each answer one change line with the ids; refusals are plain", async () => {
  const { c } = await setup();
  const back = await approved(c, "return_to_lead", { deal: "dl_seed08" });
  assert.match(
    back.headline,
    /^Moved Sam Example back to leads \(Contacted\); archived deal "Auto repair landing page" \(change chg_[a-z0-9]{12}\)$/,
  );
  assert.deepEqual(back.data, { changeId: changeIdOf(back.data), contactId: "ct_seed08", dealId: "dl_seed08" });

  const qualified = await approved(c, "qualify_lead", { contact: "ct_seed08", stage: "Replied", dealTitle: "Second try", value: 400 });
  assert.match(qualified.headline, /^Qualified Sam Example; added deal "Second try" in Replied \(change chg_[a-z0-9]{12}\)$/);
  const data = qualified.data as { changeId: string; contactId: string; dealId: string | null };
  assert.equal(data.contactId, "ct_seed08");
  assert.match(data.dealId ?? "", /^dl_/);

  assert.match(await fails(c, "return_to_lead", { deal: "dl_seed07" }), /^"Salon booking site" is Won, so it was a real opportunity/);
  assert.match(await fails(c, "return_to_lead", { deal: "dl_seed03", status: "qualified" }), /^Someone moved back to leads can't be Qualified\./);
  assert.match(await fails(c, "qualify_lead", { contact: "ct_seed01" }), /^Pat Example isn't a lead waiting to be qualified\./);
  assert.match(await fails(c, "qualify_lead", { contact: "ct_seed01", createDeal: "yes" }), /^Fix the qualify_lead request: /);
});

test("log_activity refuses a via argument: only the board marks a note as a text", async () => {
  const { c } = await setup();
  const message = await fails(c, "log_activity", { contact: "ct_seed01", type: "note", summary: "Texted.", via: "text" });
  assert.match(message, /^Fix the log_activity request: /);
  assert.match(message, /Unknown field "via"/);
});

test("writes are recorded as the ai actor: a yes under apply_changes, a small change applied at once under the tool's name", async () => {
  const { c } = await setup();
  const id = changeIdOf((await approved(c, "add_lead", { name: "Lee Example" })).data);
  const setting = changeIdOf((await ok(c, "update_settings", { aiEdits: "apply_small" })).data);
  const call = changeIdOf((await ok(c, "log_activity", { contact: "ct_seed01", type: "call", summary: "Called Pat." })).data);
  const { changes } = (await ok(c, "recent_changes")).data as { changes: { changeId: string; actor: string; tool: string }[] };
  assert.deepEqual(changes.map((ch) => [ch.changeId, ch.actor, ch.tool]), [
    [call, "ai", "log_activity"],
    [setting, "ai", "update_settings"],
    [id, "ai", "apply_changes"],
  ]);
});

test("update_deal moves a deal with a local next time, and refuses a date it can't read", async () => {
  const { c } = await setup();
  const answer = await approved(c, "update_deal", { deal: "Casey Placeholder", stage: "Call booked", nextAt: "2026-11-26T14:00" });
  assert.match(answer.headline, /^Moved "Landscaping site with a quote form" \(Casey Placeholder\) to Call booked; next: Thu Nov 26, 2:00 PM/);
  assert.match(answer.headline, CHANGE_LINE);
  assert.equal((answer.data as { dealId: string }).dealId, "dl_seed03");
  assert.match(await fails(c, "update_deal", { deal: "dl_seed03", nextAt: "next thursday" }), /^"next thursday" isn't a date I can read/);
  assert.match(await fails(c, "update_deal", { deal: "dl_seed03", status: "done" }), /"status" must be one of: open, won, lost, not_now/);
  assert.match(await fails(c, "update_deal", { deal: "dl_seed03", nextAt: null, value: "lots" }), /"value" must be a number or null/);
});

test("update_contact confirms outside fields and clears a value with null; the outside name stays out of the line", async () => {
  const { c } = await setup();
  const answer = await approved(c, "update_contact", { contact: "ct_seed02", business: "Sample Bakery & Cafe", phone: null });
  assert.match(answer.headline, /^Updated contact ct_seed02: phone and business \(change chg_[a-z0-9]{12}\)$/);
  assert.doesNotMatch(answer.text, /Robin/, "the untrusted name is not in the headline or the JSON below it");
  const { contacts } = (await ok(c, "search_contacts", { query: "Robin" })).data as {
    contacts: { phone: string | null; untrusted_fields: string[] }[];
  };
  assert.equal(contacts[0]?.phone, null);
  assert.deepEqual(contacts[0]?.untrusted_fields, ["name", "email"]);
});

test("log_activity and add_task each answer one change line", async () => {
  const { c } = await setup();
  const logged = await approved(c, "log_activity", { deal: "dl_seed01", type: "call", summary: "Called Pat. Wants a quote by Friday." });
  assert.match(logged.headline, /^Logged a call on "Website refresh for Example Plumbing" \(Pat Example\): Called Pat\./);
  assert.match(logged.headline, CHANGE_LINE);
  assert.match((logged.data as { activityId: string }).activityId, /^ac_/);

  const task = await approved(c, "add_task", { deal: "dl_seed01", title: "Send Pat the quote", dueAt: "2026-11-20" });
  assert.match(task.headline, /^Added task "Send Pat the quote" for "Website refresh for Example Plumbing" \(Pat Example\), due Fri Nov 20, 12:00 AM/);
  assert.match(task.headline, CHANGE_LINE);

  assert.match(await fails(c, "log_activity", { deal: "dl_seed01", type: "fax", summary: "x" }), /"type" must be one of: email, call, meeting, note/);
  assert.match(await fails(c, "log_activity", { type: "call", summary: "Called." }), /^This needs a deal or a contact/);
  assert.match(await fails(c, "add_task", { contact: "ct_seed01" }), /"title" is missing; it needs text/);
});

test("undo_change reverses one change and refuses a second undo", async () => {
  const { c } = await setup();
  const added = changeIdOf((await approved(c, "add_deal", { name: "Lee Example" })).data);
  const undone = await ok(c, "undo_change", { changeId: added });
  assert.match(undone.headline, new RegExp(`^Undid ${added}: Removed contact Lee Example and deal "Lee Example inquiry"`));
  assert.match(undone.headline, CHANGE_LINE);
  assert.match(await fails(c, "undo_change", { changeId: added }), new RegExp(`^${added} was already undone`));
  assert.match(await fails(c, "undo_change", { changeId: "chg_nope" }), /^There's no change chg_nope\. Use recent_changes/);
  assert.match((await ok(c, "search_contacts", { query: "Lee" })).headline, /^No contacts match/);
});

test("undo of add_deal after a logged activity refuses in plain English", async () => {
  const { c } = await setup();
  const added = (await approved(c, "add_deal", { name: "Lee Example" })).data as { changeId: string; dealId: string };
  await approved(c, "log_activity", { deal: added.dealId, type: "note", summary: "Left a voicemail." });
  assert.match(
    await fails(c, "undo_change", { changeId: added.changeId }),
    new RegExp(`^Can't undo ${added.changeId}: other records now depend on it \\(1 activity\\)\\.`),
  );
});

test("bad write input names the field and the shape it needs", async () => {
  const { c } = await setup();
  const message = await fails(c, "add_deal", { email: "lee@example.com", value: -5, extra: 1 });
  assert.match(message, /^Fix the add_deal request: /);
  assert.match(message, /"value" must be at least 0/);
  assert.match(message, /Unknown field "extra"\. Use only: name, contact, email/);
  assert.match(await fails(c, "add_task", { deal: "dl_seed01" }), /"title" is missing; it needs text \(what to do, in a few words\)\./);
  assert.match(await fails(c, "add_deal", { name: "Lee", email: "not-an-email" }), /^"not-an-email" doesn't look like an email address/);
  assert.match(await fails(c, "add_lead", { name: "Lee", dealTitle: "Shop" }), /Unknown field "dealTitle"\. Use only: name, business, email, phone, source, notes, contactFields, allowDuplicate/);
});

test("write lines, undo lines and the change log name outside records by id only", async () => {
  const { c } = await setup();
  const moved = await approved(c, "update_deal", { deal: "dl_seed02", stage: "replied" });
  assert.match(moved.headline, /^Moved deal dl_seed02 \(contact ct_seed02\) to Replied \(change chg_[a-z0-9]{12}\)$/);
  const undone = await ok(c, "undo_change", { changeId: changeIdOf(moved.data) });
  assert.match(undone.headline, /^Undid chg_[a-z0-9]{12}: Moved deal dl_seed02 back to New inquiry \(change/);

  const logged = await approved(c, "log_activity", { deal: "dl_seed02", type: "email", summary: "Replied with prices." });
  assert.match(logged.headline, /^Logged an email on deal dl_seed02 \(contact ct_seed02\): Replied with prices\./);
  const task = await approved(c, "add_task", { contact: "ct_seed02", title: "Send the menu template" });
  assert.match(task.headline, /^Added task "Send the menu template" for contact ct_seed02 \(change/);
  const again = await approved(c, "update_deal", { deal: "dl_seed02", stage: "replied" });
  await approved(c, "update_deal", { deal: "dl_seed02", nextStep: "Wait for the menu" });
  assert.match(
    await fails(c, "undo_change", { changeId: changeIdOf(again.data) }),
    /^Can't undo chg_[a-z0-9]{12}: deal dl_seed02 changed since \(see recent_changes\)/,
  );

  const { changes } = (await ok(c, "recent_changes")).data as { changes: { summary: string }[] };
  assert.equal(changes.length, 6);
  assert.ok(changes.every((change) => !/Robin/.test(change.summary)));
  for (const change of changes) assert.doesNotMatch(change.summary, /Robin|Sample Bakery/, change.summary);
});

test("setting an outside deal title makes it trusted", async () => {
  const { c } = await setup();
  const renamed = await approved(c, "update_deal", { deal: "dl_seed02", title: "Bakery website" });
  assert.match(renamed.headline, /^Updated "Bakery website" \(contact ct_seed02\): changed title/);
  const brief = (await ok(c, "get_deal", { deal: "dl_seed02" })).data as { deal: { untrusted_fields: string[] } };
  assert.deepEqual(brief.deal.untrusted_fields, ["contactName"]);
});

test("errors and questions name outside records by id only", async () => {
  const { db, c } = await setup();
  db.exec(`INSERT INTO contacts (id, name, untrusted_fields) VALUES ('ct_twin', 'Robin Sample', '["name"]')`);
  const question = await okText(c, "update_contact", { contact: "Robin Sample", phone: "555-0100" });
  assert.equal(
    question.headline,
    "Nothing was proposed: a name needs checking first. Ask the owner, then send the list again.\n" +
      "- Which Robin Sample? contact ct_seed02 or contact ct_twin. Send the list again with the id.",
  );
  // A small change applied at once goes straight to the service, which refuses the same name.
  await ok(c, "update_settings", { aiEdits: "apply_small" });
  const message = await fails(c, "log_activity", { contact: "Robin Sample", type: "call", summary: "Called." });
  assert.equal(message, '"Robin Sample" matches more than one contact: contact ct_seed02; contact ct_twin. Use the contact id instead.');
});

const dataOf = <T>(answer: { data: unknown }) => answer.data as T;

test("stage tools: add, rename keeping the key, reorder, archive refusal and undo, each ending with a change id", async () => {
  const { c } = await setup();
  const added = await ok(c, "add_stage", { label: "Demo booked", after: "Replied" });
  assert.match(added.headline, /^Added stage Demo booked \(key demo_booked\) after Replied \(change chg_[a-z0-9]{12}\)$/);
  assert.equal(dataOf<{ key: string }>(added).key, "demo_booked");

  const renamed = await ok(c, "update_stage", { stage: "Call done", label: "Met" });
  assert.match(renamed.headline, /^Renamed stage Call done to Met \(change /);
  assert.equal(dataOf<{ key: string }>(renamed).key, "call_done");
  const moved = await ok(c, "update_stage", { stage: "met", position: 1 });
  assert.match(moved.headline, /^Moved stage Met to position 1 of 9 \(change /);

  const { stages } = dataOf<{ stages: { key: string; position: number; openDeals: number }[] }>(await ok(c, "list_stages"));
  assert.deepEqual(stages.slice(0, 3).map((s) => [s.key, s.position]), [["call_done", 1], ["new_inquiry", 2], ["replied", 3]]);
  assert.equal(stages.find((s) => s.key === "call_done")?.openDeals, 1);

  assert.match(await fails(c, "archive_stage", { stage: "Met" }), /^1 open deal is in Met: "Online store for Fake Street Bikes" \(Jordan Fake\)\. Move it first with update_deal, for example to /);
  const archived = await ok(c, "archive_stage", { stage: "Demo booked" });
  assert.match(archived.headline, /^Archived stage Demo booked \(change /);
  const hidden = await ok(c, "list_stages");
  assert.ok(!dataOf<{ stages: { key: string }[] }>(hidden).stages.some((s) => s.key === "demo_booked"));
  assert.ok(dataOf<{ stages: { key: string }[] }>(await ok(c, "list_stages", { includeArchived: true })).stages.some((s) => s.key === "demo_booked"));

  const undone = await ok(c, "undo_change", { changeId: dataOf<{ changeId: string }>(archived).changeId });
  assert.match(undone.headline, /^Undid chg_[a-z0-9]{12}: /);
  assert.match(await fails(c, "update_stage", { stage: "Met" }), /^Nothing to change on Met/);
  assert.match(await fails(c, "update_stage", { stage: "Met", position: 0 }), /"position" must be at least 1/);
  assert.match(await fails(c, "add_stage", { label: "Odd", kind: "done" }), /"kind" must be one of: open, won, lost, not_now/);
});

test("field tools: add, validate values on update_deal, refuse a used choice, archive", async () => {
  const { c } = await setup();
  const added = await ok(c, "add_field", { entity: "deal", label: "Temperature", type: "choice", choices: ["Cold", "Warm", "Hot"] });
  assert.match(added.headline, /^Added deal field Temperature \(key temperature, choice: Cold, Warm, Hot\) \(change chg_[a-z0-9]{12}\)$/);
  const { fieldId } = dataOf<{ fieldId: string; key: string }>(added);
  assert.match(fieldId, /^fd_/);

  assert.match(await fails(c, "update_deal", { deal: "dl_seed01", fields: { temperature: "Lukewarm" } }), /"Lukewarm" isn't one of the choices for Temperature: Cold, Warm, Hot/);
  await approved(c, "update_deal", { deal: "dl_seed01", fields: { temperature: "Warm" } });
  assert.match(await fails(c, "update_field", { field: fieldId, choices: ["Cold", "Hot"] }), /^Can't remove the choice Warm from Temperature: 1 deal uses it/);

  const grown = await ok(c, "update_field", { field: "deal.temperature", choices: ["Cold", "Warm", "Hot", "On fire"] });
  assert.match(grown.headline, /^Updated deal field Temperature: added the choice On fire \(change /);
  const { fields } = dataOf<{ fields: { id: string; choices: string[] | null; archived: boolean }[] }>(await ok(c, "list_fields", { entity: "deal" }));
  assert.deepEqual(fields.map((f) => [f.id, f.choices, f.archived]), [[fieldId, ["Cold", "Warm", "Hot", "On fire"], false]]);
  assert.equal((await ok(c, "list_fields", { entity: "contact" })).headline, "There are no custom fields yet. Add one with add_field.");

  const archived = await ok(c, "update_field", { field: "Temperature", archived: true });
  assert.match(archived.headline, /archived \(change /);
  assert.match(await fails(c, "update_deal", { deal: "dl_seed01", fields: { temperature: "Hot" } }), /deal field "temperature" is archived/);
  assert.match(await fails(c, "add_field", { entity: "deal", label: "X", type: "color" }), /"type" must be one of: text, number, date, choice/);
});

test("complete_task and snooze_task answer a change line and are undoable", async () => {
  const { c } = await setup();
  const snoozed = await approved(c, "snooze_task", { task: "tk_seed02", until: "2026-11-20T09:00" });
  assert.match(snoozed.headline, /^Snoozed task "Send Casey the price sheet" for "Landscaping site with a quote form" \(Casey Placeholder\) until Fri Nov 20, 9:00 AM \(change chg_[a-z0-9]{12}\)$/);
  const due = dataOf<{ overdueTasks: { id: string }[] }>(await ok(c, "whats_due"));
  assert.ok(!due.overdueTasks.some((t) => t.id === "tk_seed02"), "snoozed tasks are hidden from whats_due");

  const done = await approved(c, "complete_task", { task: "tk_seed01" });
  assert.match(done.headline, /^Completed task "Prepare questions for Pat's call" for "Website refresh for Example Plumbing" \(Pat Example\) \(change /);
  assert.match(await fails(c, "complete_task", { task: "tk_seed01" }), /is already done/);
  assert.match(await fails(c, "snooze_task", { task: "tk_seed03", until: "2026-11-18" }), /in the future/);
  assert.match(await fails(c, "snooze_task", { task: "tk_seed03" }), /"until" is missing/);
  const undone = await ok(c, "undo_change", { changeId: dataOf<{ changeId: string }>(done).changeId });
  assert.match(undone.headline, /^Undid chg_[a-z0-9]{12}: Put back the earlier done date on task/);
});

test("update_rulebook replaces or adds a document that get_rulebook then returns", async () => {
  const { c } = await setup();
  const updated = await ok(c, "update_rulebook", { name: "voice", markdown: "# Voice\n\nShort and warm." });
  assert.match(updated.headline, /^Updated rulebook document "voice" \(change chg_[a-z0-9]{12}\)$/);
  const added = await ok(c, "update_rulebook", { name: "pricing", markdown: "Only quote from the price sheet." });
  assert.match(added.headline, /^Added rulebook document "pricing" \(change /);
  const { documents } = dataOf<{ documents: { name: string; markdown: string }[] }>(await ok(c, "get_rulebook"));
  assert.deepEqual(documents.map((d) => d.name), ["leads", "capture", "voice", "pipeline", "guardrails", "pricing"]);
  assert.equal(documents[2]?.markdown, "# Voice\n\nShort and warm.");
  const undone = await ok(c, "undo_change", { changeId: dataOf<{ changeId: string }>(updated).changeId });
  assert.match(undone.headline, /^Undid chg_[a-z0-9]{12}: Put back the earlier markdown on rulebook "voice"/);
  assert.match(await fails(c, "update_rulebook", { name: "bad name!", markdown: "x" }), /letters, numbers/);
});

test("settings tools: get shows the owner emails, update changes the rest and refuses owner emails", async () => {
  const { db, c } = await setup();
  db.exec(`UPDATE settings SET owner_emails = '["owner@example.com"]'`);
  const before = await ok(c, "get_settings");
  assert.equal(before.headline, "Timezone America/Los_Angeles; the daily brief is off (7:00 AM).");
  assert.deepEqual(before.data, {
    timezone: "America/Los_Angeles",
    briefHour: 7,
    briefEmail: null,
    briefEnabled: false,
    ownerEmails: ["owner@example.com"],
    businessName: null,
    accentColor: null,
    aiEdits: "review_first",
    timeTracking: false,
    lastBriefAt: "2026-11-18T17:30:00.000Z",
    lastBriefSentAt: null,
  });

  const changed = await ok(c, "update_settings", { timezone: "Europe/London", briefHour: 8, briefEmail: "owner@example.com", briefEnabled: true });
  assert.match(changed.headline, /^Updated settings: timezone to Europe\/London, brief hour to 8:00, brief email to owner@example\.com and the daily brief on \(change chg_[a-z0-9]{12}\)$/);
  assert.match(await fails(c, "update_settings", { briefEmail: "me@example.com" }), /The brief can only go to an owner email \(owner@example\.com\)/);
  assert.match(await fails(c, "update_settings", { timezone: "Mars/Base" }), /isn't a timezone I know/);
  assert.match(await fails(c, "update_settings", { briefHour: 25 }), /"briefHour" must be at most 23/);
  const refused = await fails(c, "update_settings", { ownerEmails: ["intruder@example.com"] });
  assert.match(refused, /Unknown field "ownerEmails"\. Use only: timezone, briefHour, briefEmail, briefEnabled, businessName, accentColor, aiEdits/);
  assert.deepEqual(dataOf<{ ownerEmails: string[] }>(await ok(c, "get_settings")).ownerEmails, ["owner@example.com"]);
  const cleared = await ok(c, "update_settings", { briefEmail: null });
  assert.match(cleared.headline, /brief email cleared/);
  const undone = await ok(c, "undo_change", { changeId: dataOf<{ changeId: string }>(cleared).changeId });
  assert.match(undone.headline, /^Undid chg_[a-z0-9]{12}: Put back the earlier brief email on the settings/);
});

test("update_settings sets the business name and accent colour, get_settings shows them, and undo puts them back", async () => {
  const { c } = await setup();
  const changed = await ok(c, "update_settings", { businessName: "Fernwood Engineering", accentColor: "#1E4A3D" });
  assert.match(changed.headline, /^Updated settings: business name to "Fernwood Engineering" and accent colour to #1e4a3d \(change chg_[a-z0-9]{12}\)$/);
  const shown = dataOf<{ businessName: string | null; accentColor: string | null }>(await ok(c, "get_settings"));
  assert.deepEqual([shown.businessName, shown.accentColor], ["Fernwood Engineering", "#1e4a3d"]);

  assert.match(await fails(c, "update_settings", { accentColor: "#d0e8dc" }), /too light to use on the board.*Pick a darker colour\./);
  assert.match(await fails(c, "update_settings", { accentColor: "blue" }), /^That isn't a colour I can use: give it as #rrggbb, for example #2b6455\.$/);
  assert.match(await fails(c, "update_settings", { businessName: "x".repeat(61) }), /at most 60 characters/);

  await ok(c, "undo_change", { changeId: dataOf<{ changeId: string }>(changed).changeId });
  const after = dataOf<{ businessName: string | null; accentColor: string | null }>(await ok(c, "get_settings"));
  assert.deepEqual([after.businessName, after.accentColor], [null, null]);
});

test("update_settings accepts a brief email from the OWNER_EMAILS var too", async () => {
  const db = await createTestDb();
  db.exec(buildFixtureSeed(NOW, DEFAULT_TZ));
  const c = await connectInMemory(createMcpServer({ db, now: () => NOW, ownerEmailsVar: "a@example.test, Var@Example.test" }));
  const changed = await ok(c, "update_settings", { briefEmail: "var@example.test" });
  assert.match(changed.headline, /brief email to var@example\.test/);
});
