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
import { PROPOSAL_ACTIONS, type ProposalActionName, type RecordAction, recordActionSchema } from "./proposal-actions.ts";
import { checkListShows, proposeChanges } from "./proposals.ts";
import { shownList } from "./proposal-text.ts";

const NOW = new Date("2026-11-19T18:00:00.000Z");
const DEPS = { extraOwnerEmails: [] };

const SETUP = [
  "UPDATE settings SET time_tracking = 1, projects = 1",
  "INSERT INTO projects (id, name, contact_id, status_key) VALUES ('pj_seed01', 'Retrofit', 'ct_seed01', 'active')",
  WORK_TYPES_SQL,
  "INSERT INTO field_defs (id, entity, key, label, type) VALUES ('fd_budget', 'deal', 'budget', 'Budget', 'number'), " +
    "('fd_size', 'contact', 'size', 'Team size', 'text'), ('fd_scope', 'project', 'scope', 'Scope', 'text')",
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

/** A finished half hour on the project, with its own task. */
const ENTRY_ON_PROJECT =
  "INSERT INTO tasks (id, contact_id, project_id, title) VALUES ('tk_proj', 'ct_seed01', 'pj_seed01', 'Order anchors'); " +
  "INSERT INTO time_entries (id, contact_id, project_id, started_at, ended_at, minutes, billable) VALUES ('te_proj', 'ct_seed01', 'pj_seed01', '2026-11-18T17:00:00.000Z', '2026-11-18T17:30:00.000Z', 30, 0)";

/** An open task on the won deal, for a project that moves it. */
const OPEN_TASK_ON_WON_DEAL = "INSERT INTO tasks (id, deal_id, contact_id, title) VALUES ('tk_won', 'dl_seed07', 'ct_seed07', 'Hang the sign')";
/** The seeded project, with dates and notes to clear. */
const PROJECT_WITH_DATES =
  "UPDATE projects SET start_at = '2026-12-01T08:00:00.000Z', target_at = '2027-01-30T08:00:00.000Z', notes = 'Phase one.' WHERE id = 'pj_seed01'";

/** A template with a nested task, due days and a work type. */
const TEMPLATE_KIT =
  "INSERT INTO project_templates (id, name, description) VALUES ('tp_kit', 'Kitchen kit', 'The usual.'); " +
  "INSERT INTO template_tasks (id, template_id, parent_id, position, title, due_days, work_type_id) VALUES " +
  "('tt_a', 'tp_kit', NULL, 1, 'Survey', 3, 'wt_design'), ('tt_b', 'tp_kit', 'tt_a', 1, 'Measure', NULL, NULL)";

/** A lead rule and a stage-entry rule to edit. */
const MORE_RULES =
  "INSERT INTO rules (id, type, params, description, active, created_by) VALUES " +
  "('ru_lead', 'lead_followup', '{\"type\":\"lead_followup\",\"status\":\"new\",\"days\":3}', 'When a lead has been New for 3 days with no contact logged, add a follow-up task.', 1, 'owner'), " +
  "('ru_enter', 'on_stage_enter', '{\"type\":\"on_stage_enter\",\"stage\":\"call_done\",\"title\":\"Send notes\",\"dueInDays\":1}', 'When a deal enters Call done, add the task \"Send notes\", due 1 day later.', 1, 'owner')";

type Variant = { input: Record<string, unknown>; setup?: string };

/** Each record action with each optional field set at least once, in inputs the service accepts. */
const VARIANTS: Record<ProposalActionName, Variant[]> = {
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
    { input: { project: "Retrofit", type: "call", summary: "Pat approved the anchors." } },
  ],
  add_task: [
    { input: { deal: "dl_seed01", title: "Send the examples", dueAt: "2026-11-21" } },
    { input: { contact: "ct_seed06", title: "Find the card" } },
    { input: { project: "pj_seed01", title: "Order anchors", dueAt: "2026-11-21" } },
    { input: { parent: "tk_proj", title: "Check the anchors", dueAt: "2026-11-22" }, setup: ENTRY_ON_PROJECT },
  ],
  complete_task: [
    { input: { task: "tk_seed01" } },
    { input: { task: "tk_proj", subTasks: "complete" }, setup: `${ENTRY_ON_PROJECT}; INSERT INTO tasks (id, contact_id, project_id, parent_id, position, title) VALUES ('tk_kid', 'ct_seed01', 'pj_seed01', 'tk_proj', 1, 'Check anchors')` },
    { input: { task: "tk_proj", subTasks: "leave" }, setup: `${ENTRY_ON_PROJECT}; INSERT INTO tasks (id, contact_id, project_id, parent_id, position, title) VALUES ('tk_kid', 'ct_seed01', 'pj_seed01', 'tk_proj', 1, 'Check anchors')` },
  ],
  snooze_task: [{ input: { task: "tk_seed02", until: "2026-11-22" } }],
  start_timer: [
    { input: { deal: "dl_seed01", workType: "Design" } },
    { input: { contact: "ct_seed03" } },
    { input: { task: "tk_seed03", workType: "Admin" } },
    { input: { project: "Retrofit", workType: "Design" } },
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
    { input: { project: "Retrofit", startedAt: "2026-11-19T07:30", minutes: 20, workType: "Design" } },
    { input: { task: "tk_proj", startedAt: "2026-11-19T07:30", minutes: 20 }, setup: ENTRY_ON_PROJECT },
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
    { input: { entry: "te_done", project: "pj_seed01", task: null } },
    { input: { entry: "te_proj", project: null }, setup: ENTRY_ON_PROJECT },
  ],
  add_project: [
    {
      input: { deal: "dl_seed07", name: "Salon launch", status: "On hold", startAt: "2026-12-01", targetAt: "2027-01-30", notes: "Phase one.", moveOpenTasks: true },
      setup: OPEN_TASK_ON_WON_DEAL,
    },
    { input: { contact: "ct_seed03", name: "Garden path" } },
    { input: { deal: "dl_seed07" } },
    { input: { name: "Office move" } },
    { input: { deal: "dl_seed07", name: "Salon launch", completeOpenTasks: true }, setup: OPEN_TASK_ON_WON_DEAL },
    { input: { deal: "dl_seed07", name: "Salon launch", moveOpenTasks: true, completeOpenTasks: true }, setup: OPEN_TASK_ON_WON_DEAL },
    { input: { name: "Office move", fields: { scope: "Two floors" } } },
    { input: { name: "Kitchen job", template: "Kitchen kit" }, setup: TEMPLATE_KIT },
    { input: { name: "Kitchen job", template: "tp_kit", startAt: "2026-12-01", moveOpenTasks: true, deal: "dl_seed07" }, setup: `${TEMPLATE_KIT}; ${OPEN_TASK_ON_WON_DEAL}` },
  ],
  add_task_plan: [
    {
      input: {
        project: "Retrofit",
        under: "tk_proj",
        tasks: [{ title: "Survey", dueDays: 3, workType: "Design" }, { title: "Measure", under: 1, due: "2026-12-05" }, { title: "Order" }],
      },
      setup: `${ENTRY_ON_PROJECT}; UPDATE projects SET start_at = '2026-12-01T08:00:00.000Z' WHERE id = 'pj_seed01'`,
    },
  ],
  add_template: [
    { input: { name: "Retrofit kit", description: "For retrofits.", tasks: [{ title: "Survey", dueDays: 3, workType: "Design" }, { title: "Measure", under: 1 }, { title: "Order" }] } },
    { input: { name: "Bare kit", tasks: [{ title: "One" }] } },
  ],
  update_template: [
    { input: { template: "tp_kit", name: "Kitchen kit 2", description: "Changed." }, setup: TEMPLATE_KIT },
    { input: { template: "Kitchen kit", description: null }, setup: TEMPLATE_KIT },
    { input: { template: "tp_kit", archived: true }, setup: TEMPLATE_KIT },
    { input: { template: "tp_kit", tasks: [{ title: "Fresh survey", dueDays: 1, workType: "Admin" }, { title: "Sub", under: 1 }] }, setup: TEMPLATE_KIT },
  ],
  save_project_as_template: [
    { input: { project: "pj_seed01", name: "Saved kit", description: "From Retrofit." }, setup: `${ENTRY_ON_PROJECT}; UPDATE projects SET start_at = '2026-12-01T08:00:00.000Z' WHERE id = 'pj_seed01'; UPDATE tasks SET due_at = '2026-12-04T08:00:00.000Z', work_type_id = 'wt_design' WHERE id = 'tk_proj'` },
  ],
  update_project: [
    { input: { project: "Retrofit", name: "Retrofit phase 2", status: "done", startAt: "2026-12-02", targetAt: "2027-02-01", notes: "Anchors ordered." } },
    { input: { project: "pj_seed01", startAt: null, targetAt: null, notes: null }, setup: PROJECT_WITH_DATES },
    { input: { project: "pj_seed01", fields: { scope: "Three floors" } } },
    { input: { project: "pj_seed01", archived: true } },
    { input: { project: "pj_seed01", status: "on_hold", archived: false } },
  ],
  // Rule actions are only proposed while the owner approves on the board only (decision 0061).
  add_rule: [
    { input: { type: "stage_followup", stage: "call_done", days: 3, title: "Check in with {contact}", description: "Nudge after a call." } },
    { input: { type: "on_stage_enter", stage: "Call done", title: "Send the notes for {deal}", dueInDays: 1 } },
    { input: { type: "gone_quiet", days: 7 } },
    { input: { type: "lead_followup", status: "contacted", days: 4, title: "Ring {contact}" } },
  ],
  update_rule: [
    { input: { rule: "ru_seed01", days: 9 } },
    { input: { rule: "ru_seed02", stage: "Call done", days: 4, title: null, description: "Chase quiet calls." } },
    { input: { rule: "ru_lead", status: "contacted", days: 6 }, setup: MORE_RULES },
    { input: { rule: "ru_enter", stage: "Proposal sent", title: "Send the plan", dueInDays: 2 }, setup: MORE_RULES },
  ],
  pause_rule: [{ input: { rule: "ru_seed01" } }],
  resume_rule: [{ input: { rule: "ru_seed02" } }],
};

const ctx = (db: Ctx["db"]): Ctx => ({ db, now: NOW, actor: "ai", tool: "propose_changes" });

async function proposeOne(variant: Variant, action: ProposalActionName) {
  const db = await createTestDb();
  db.exec(buildFixtureSeed(NOW, DEFAULT_TZ));
  db.exec(SETUP);
  if (variant.setup !== undefined) db.exec(variant.setup);
  if (action.endsWith("_rule")) db.exec("UPDATE settings SET ai_approval = 'board'");
  const answer = await proposeChanges(ctx(db), { actions: [{ action, ...variant.input } as RecordAction] }, DEPS);
  assert.equal(answer.kind, "proposal", `${action} ${JSON.stringify(variant.input)}: ${JSON.stringify(answer)}`);
  return answer.kind === "proposal" ? answer : assert.fail();
}

test("every record and rule action with each optional field set proposes a list that shows every column it writes", async () => {
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
  assert.deepEqual(Object.keys(VARIANTS).sort(), [...PROPOSAL_ACTIONS].sort());
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

test("records on a project name it in the list, and every column they write shows", async () => {
  const task = await proposeOne(VARIANTS.add_task[2] as Variant, "add_task");
  assert.deepEqual(task.list.tasks.map((item) => [item.record, item.fields]), [
    ['New task "Order anchors"', [{ field: "for", to: 'project "Retrofit" (Pat Example)' }, { field: "due", to: "Sat Nov 21" }]],
  ]);
  const note = await proposeOne(VARIANTS.log_activity[2] as Variant, "log_activity");
  assert.deepEqual(note.list.notes.map((item) => item.record), ['Call with Pat Example about project "Retrofit"']);
  const time = await proposeOne(VARIANTS.add_time_entry[3] as Variant, "add_time_entry");
  assert.match(timeLines(time.text)[0] ?? "", /, for project "Retrofit" \(Pat Example\): started /);
  const cleared = await proposeOne(VARIANTS.update_time_entry[9] as Variant, "update_time_entry");
  assert.match(timeLines(cleared.text)[0] ?? "", /for Pat Example: was .*for project "Retrofit" \(Pat Example\)/);
});

test("a task that moves from a deal to a project shows one for line, and it counts as shown", async () => {
  const db = await createTestDb();
  db.exec(buildFixtureSeed(NOW, DEFAULT_TZ));
  db.exec(SETUP);
  const before = await db.prepare("SELECT * FROM tasks WHERE id = 'tk_seed01'").first<Row>();
  assert.ok(before);
  const after = { ...before, deal_id: null, project_id: "pj_seed01", version: Number(before.version) + 1 };
  const input: ChangeInput = { target: { table: "tasks", id: "tk_seed01" }, summary: "", changes: [{ table: "tasks", id: "tk_seed01", before, after }] };
  const { list, unshown } = await shownList(db, input, DEFAULT_TZ, NOW);
  assert.deepEqual(unshown, []);
  assert.deepEqual(list.tasks.map((item) => item.fields), [[{ field: "for", from: '"Website refresh for Example Plumbing" (Pat Example)', to: 'project "Retrofit" (Pat Example)' }]]);
});
