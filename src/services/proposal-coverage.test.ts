// The list shows every change (decision 0044, "The list"): propose refuses, with a plain internal error, a list that
// would write a column it doesn't show. This walks every record action with each of its optional fields set, so a new
// field the list forgets fails here rather than reaching the owner.
import assert from "node:assert/strict";
import { test } from "node:test";
import { buildFixtureSeed } from "../../tests/helpers/fixture-seed.ts";
import { WORK_TYPES_SQL } from "../../tests/helpers/time-seed.ts";
import { createTestDb } from "../db/sqlite-d1.ts";
import { DEFAULT_TZ } from "../time.ts";
import type { ChangeInput, Ctx, Row } from "./change.ts";
import { RECORD_ACTIONS, type RecordAction, type RecordActionName, recordActionSchema } from "./proposal-actions.ts";
import { checkListShows, proposeChanges } from "./proposals.ts";
import { shownList } from "./proposal-text.ts";

const NOW = new Date("2026-11-19T18:00:00.000Z");
const DEPS = { extraOwnerEmails: [] };

const SETUP = [
  "UPDATE settings SET time_tracking = 1",
  WORK_TYPES_SQL,
  "INSERT INTO field_defs (id, entity, key, label, type) VALUES ('fd_budget', 'deal', 'budget', 'Budget', 'number'), " +
    "('fd_size', 'contact', 'size', 'Team size', 'text')",
  // Sam is a lead, with a lost deal and no open one.
  "UPDATE contacts SET person_status = 'lead', sub_status = 'new', lead_status = 'new', lead_status_at = '2026-11-19T18:00:00.000Z' WHERE id = 'ct_seed08'",
  // A finished hour on Pat's deal and task.
  "INSERT INTO time_entries (id, contact_id, deal_id, task_id, started_at, ended_at, minutes, work_type_id, billable, rate, notes) VALUES " +
    "('te_done', 'ct_seed01', 'dl_seed01', 'tk_seed01', '2026-11-18T17:00:00.000Z', '2026-11-18T18:00:00.000Z', 60, 'wt_design', 1, 95, 'Wireframes.')",
].join("; ");

/** A timer on Pat's deal since 8:30 AM. */
const RUNNING_ON_PAT =
  "INSERT INTO time_entries (id, contact_id, deal_id, started_at, work_type_id, billable) VALUES ('te_run', 'ct_seed01', 'dl_seed01', '2026-11-19T16:30:00.000Z', 'wt_design', 1)";
/** A timer for no person or deal since 8:30 AM. */
const RUNNING_ALONE = "INSERT INTO time_entries (id, started_at, billable) VALUES ('te_run', '2026-11-19T16:30:00.000Z', 0)";

type Variant = { input: Record<string, unknown>; setup?: string };

/** Each record action with each optional field set at least once, in inputs the service accepts. */
const VARIANTS: Record<RecordActionName, Variant[]> = {
  add_lead: [
    { input: { name: "Lee Example", business: "Lee Example Signs", email: "lee@example.com", phone: "+1 555 0101", source: "drove past", notes: "Wants a sign.", contactFields: { size: "5" } } },
    { input: { business: "Example Sample Signs", allowDuplicate: true } },
  ],
  add_deal: [
    {
      input: {
        name: "Kim Example", email: "kim@example.com", phone: "+1 555 0102", business: "Kim Example Florist", source: "referral",
        notes: "Wants a site.", dealTitle: "Florist site", value: 900, nextStep: "Send a quote", nextAt: "2026-11-25T10:00",
        fields: { budget: 900 }, contactFields: { size: "3" },
      },
    },
    { input: { contact: "ct_seed08", dealTitle: "Brake service page" } },
  ],
  add_contact: [
    { input: { name: "Ray Example", email: "ray@example.com", phone: "+1 555 0103", business: "Ray Example Print", source: "referral", notes: "A printer.", personStatus: "contact", subStatus: "client", fields: { size: "2" } } },
    { input: { name: "Pat Example", business: "Example Plumbing", personStatus: "partner", allowDuplicate: true } },
  ],
  update_contact: [
    { input: { contact: "ct_seed03", name: "Casey Q Placeholder", email: "casey@example.com", phone: "+1 555 0104", business: "Placeholder Gardens", source: "referral", notes: "Likes ferns.", fields: { size: "4" } } },
    { input: { contact: "ct_seed03", email: null, phone: null, business: null, source: null, notes: null } },
    { input: { contact: "ct_seed07", leadStatus: "not_now", followUpDate: "2026-12-01" } },
    { input: { contact: "ct_seed03", personStatus: "contact", subStatus: "client" } },
    { input: { contact: "ct_seed07", personStatus: "partner", subStatus: null } },
  ],
  update_deal: [
    { input: { deal: "dl_seed01", stage: "Proposal sent", title: "Booking site for Example Plumbing", value: 1700, nextStep: "Wait for the yes", nextAt: "2026-11-24", fields: { budget: 1700 } } },
    { input: { deal: "dl_seed01", value: null, nextStep: null, nextAt: null } },
    { input: { deal: "dl_seed05", status: "won" } },
  ],
  qualify_lead: [
    { input: { contact: "ct_seed08", stage: "Call booked", dealTitle: "Repair shop site", value: 800, nextStep: "Call Sam", nextAt: "2026-11-23" } },
    { input: { contact: "ct_seed08", createDeal: false } },
  ],
  return_to_lead: [{ input: { deal: "dl_seed03" } }, { input: { deal: "dl_seed03", status: "not_now" } }],
  log_activity: [
    { input: { deal: "dl_seed01", type: "call", summary: "Pat called back.", occurredAt: "2026-11-19T09:15" } },
    { input: { contact: "ct_seed06", type: "note", summary: "Morgan wrote in." } },
  ],
  add_task: [
    { input: { deal: "dl_seed01", title: "Send the examples", dueAt: "2026-11-21" } },
    { input: { contact: "ct_seed06", title: "Find the card" } },
  ],
  complete_task: [{ input: { task: "tk_seed01" } }],
  snooze_task: [{ input: { task: "tk_seed02", until: "2026-11-22" } }],
  start_timer: [
    { input: { deal: "dl_seed01", workType: "Design" } },
    { input: { contact: "ct_seed03" } },
    { input: { task: "tk_seed03", workType: "Admin" } },
  ],
  stop_timer: [
    { input: { notes: "Homepage draft done.", nextStepDate: "2026-11-21" }, setup: RUNNING_ON_PAT },
    { input: { workType: "Admin", billable: true, startedAt: "2026-11-19T08:00", endedAt: "2026-11-19T09:45" }, setup: RUNNING_ON_PAT },
    { input: { notes: "Sorted the receipts." }, setup: RUNNING_ALONE },
    { input: { startedAt: "2026-11-19T09:00" }, setup: RUNNING_ALONE },
  ],
  add_time_entry: [
    { input: { deal: "dl_seed01", startedAt: "2026-11-19T07:30", endedAt: "2026-11-19T09:00", workType: "Design", notes: "Booking mock-up." } },
    { input: { contact: "ct_seed03", startedAt: "2026-11-19T07:30", minutes: 45, billable: false } },
    { input: { task: "tk_seed03", startedAt: "2026-11-19T07:30", minutes: 20 } },
  ],
  update_time_entry: [
    { input: { entry: "te_done", contact: "ct_seed03", deal: null, task: null } },
    { input: { entry: "te_done", deal: "dl_seed04", task: "tk_seed03" } },
    { input: { entry: "te_done", startedAt: "2026-11-18T08:30", notes: "Wireframes, both pages." } },
    { input: { entry: "te_done", endedAt: "2026-11-18T10:30" } },
    { input: { entry: "te_done", minutes: 30, workType: "Admin", billable: true } },
    { input: { entry: "te_done", workType: null, notes: null } },
    { input: { entry: "te_done", archived: true } },
    { input: { entry: "te_done", archived: true, notes: "Duplicate of Tuesday's.", minutes: 45 } },
  ],
};

const ctx = (db: Ctx["db"]): Ctx => ({ db, now: NOW, actor: "ai", tool: "propose_changes" });

async function proposeOne(variant: Variant, action: RecordActionName) {
  const db = await createTestDb();
  db.exec(buildFixtureSeed(NOW, DEFAULT_TZ));
  db.exec(SETUP);
  if (variant.setup !== undefined) db.exec(variant.setup);
  const answer = await proposeChanges(ctx(db), { actions: [{ action, ...variant.input } as RecordAction] }, DEPS);
  assert.equal(answer.kind, "proposal", `${action} ${JSON.stringify(variant.input)}: ${JSON.stringify(answer)}`);
  return answer.kind === "proposal" ? answer : assert.fail();
}

test("every record action with each optional field set proposes a list that shows every column it writes", async () => {
  for (const schema of recordActionSchema.options) {
    const action = schema.shape.action.value;
    const optional = Object.entries(schema.shape)
      .filter(([key, field]) => key !== "action" && (field as { safeParse: (v: unknown) => { success: boolean } }).safeParse(undefined).success)
      .map(([key]) => key);
    const variants = VARIANTS[action];
    const set = new Set(variants.flatMap((variant) => Object.keys(variant.input)));
    assert.deepEqual(optional.filter((key) => !set.has(key)), [], `${action}: every optional field is set in some variant`);
    for (const variant of variants) {
      try {
        await proposeOne(variant, action);
      } catch (error) {
        assert.fail(`${action} ${JSON.stringify(variant.input)}: ${String(error)}`);
      }
    }
  }
  assert.deepEqual(Object.keys(VARIANTS).sort(), [...RECORD_ACTIONS].sort());
});

const timeLines = (text: string) => text.split("\n").filter((line) => line.startsWith("- Time") || line.startsWith("- Timer"));

test("an added entry shows its start and notes", async () => {
  const { text } = await proposeOne(VARIANTS.add_time_entry[0] as Variant, "add_time_entry");
  assert.deepEqual(timeLines(text), [
    '- Time 1 h 30 min, Design, billable at $95.00/h ($142.50), for "Website refresh for Example Plumbing" (Pat Example): started Thu Nov 19, 7:30 AM; notes Booking mock-up.',
  ]);
});

test("a stopped timer for no one shows its notes, and a stop that moves the start shows the start", async () => {
  const notes = await proposeOne(VARIANTS.stop_timer[2] as Variant, "stop_timer");
  assert.deepEqual(timeLines(notes.text), ["- Time 1 h 30 min, not billable: notes Sorted the receipts."]);
  assert.deepEqual(notes.list.notes, [], "no person, so no note is logged");
  const moved = await proposeOne(VARIANTS.stop_timer[3] as Variant, "stop_timer");
  assert.deepEqual(timeLines(moved.text), ["- Time 1 h, not billable: started Thu Nov 19, 8:30 AM -> Thu Nov 19, 9:00 AM"]);
});

test("an archive with other edits shows every edit beside it", async () => {
  const plain = await proposeOne(VARIANTS.update_time_entry[6] as Variant, "update_time_entry");
  assert.deepEqual(timeLines(plain.text), ['- Time 1 h, Design, billable at $95.00/h ($95.00), for "Website refresh for Example Plumbing" (Pat Example): archived']);
  const edited = await proposeOne(VARIANTS.update_time_entry[7] as Variant, "update_time_entry");
  const [line] = timeLines(edited.text);
  assert.match(line ?? "", /^- Time 45 min, Design, billable at \$95\.00\/h \(\$71\.25\), for .*: archived; was 1 h, Design, billable at \$95\.00\/h \(\$95\.00\), for .*; notes Wireframes\. -> Duplicate of Tuesday's\.$/);
});

test("a row column the list doesn't show refuses the list with the plain internal error", async () => {
  const db = await createTestDb();
  db.exec(buildFixtureSeed(NOW, DEFAULT_TZ));
  db.exec(SETUP);
  const entry = await db.prepare("SELECT * FROM time_entries WHERE id = 'te_done'").first<Row>();
  assert.ok(entry);
  // An entry pointed at a note the list doesn't hold, beside a notes edit it shows: the per-row check still refuses.
  const after = { ...entry, notes: "Wireframes, both pages.", activity_id: "ac_seed01", version: Number(entry.version) + 1 };
  const input: ChangeInput = { target: { table: "time_entries", id: "te_done" }, summary: "", changes: [{ table: "time_entries", id: "te_done", before: entry, after }] };
  const { list, unshown } = await shownList(db, input, DEFAULT_TZ, NOW);
  assert.equal(list.time.length, 1, "the notes edit shows");
  assert.deepEqual(unshown, ["time_entries:te_done activity_id"]);
  assert.throws(() => checkListShows(unshown), /^Error: This list would change records it doesn't show\. Nothing was proposed\.$/);
});
