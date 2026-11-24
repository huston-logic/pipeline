import assert from "node:assert/strict";
import { test } from "node:test";
import { CHANGE_LINE, connectInMemory, fails, ok, okText } from "../../tests/helpers/mcp-client.ts";
import { countOf, timeDb } from "../../tests/helpers/time-seed.ts";
import { createMcpServer } from "./server.ts";

// Thu Nov 19, 10:00 AM in Los Angeles.
const NOW = new Date("2026-11-19T18:00:00.000Z");

async function setup(options: { on?: boolean } = {}) {
  const db = await timeDb(NOW, options);
  const c = await connectInMemory(createMcpServer({ db, now: () => NOW }));
  return { db, c };
}

const TIME_CALLS: [string, Record<string, unknown>][] = [
  ["start_timer", { contact: "ct_seed01" }],
  ["stop_timer", {}],
  ["add_time_entry", { contact: "ct_seed01", startedAt: "2026-11-19T08:00", minutes: 30 }],
  ["update_time_entry", { entry: "te_aaaaaaaaaaaa", minutes: 30 }],
  ["list_time", {}],
  ["list_work_types", {}],
  ["add_work_type", { name: "Copywriting" }],
  ["update_work_type", { workType: "Design", hourlyRate: 100 }],
  ["set_client_rate", { workType: "Design", contact: "ct_seed01", hourlyRate: 120 }],
];

test("time tools refuse while time tracking is off", async () => {
  const { db, c } = await setup({ on: false });
  for (const [tool, args] of TIME_CALLS) {
    assert.equal(await fails(c, tool, args), "Time tracking is off. The owner can turn it on (update_settings timeTracking true).", tool);
  }
  assert.equal(await countOf(db, "proposals"), 0);
  assert.equal(await countOf(db, "audit_log"), 0);

  // The owner turns it on by asking; get_settings shows it.
  const on = await ok(c, "update_settings", { timeTracking: true });
  assert.match(on.headline, /^Updated settings: time tracking on \(change chg_[a-z0-9]{12}\)$/);
  assert.equal(((await ok(c, "get_settings")).data as { timeTracking: boolean }).timeTracking, true);
  assert.match((await ok(c, "list_time")).headline, /^No time this week \(Mon Nov 16 to Sun Nov 22\)\.$/);
});

test("add_time_entry under review first is a proposal", async () => {
  const { db, c } = await setup();
  const answer = await okText(c, "add_time_entry", { contact: "Pat Example", startedAt: "2026-11-19T07:30", endedAt: "2026-11-19T09:00", workType: "Design" });
  const { proposal } = answer.data as { proposal: string; list: { time: { id: string }[] } };
  assert.match(proposal, /^pr_[a-z2-7]{12}$/);
  assert.equal(answer.headline.split("\n").slice(2, 4).join("\n"), "Time\n- Time 1 h 30 min, Design, billable at $95.00/h ($142.50), for Pat Example: started Thu Nov 19, 7:30 AM");
  assert.equal(await countOf(db, "time_entries"), 0, "nothing written yet");

  const applied = await ok(c, "apply_changes", { proposal });
  assert.match(applied.headline, new RegExp(`^Applied ${proposal}: Added time 1 h 30 min, Design, billable at \\$95\\.00/h \\(\\$142\\.50\\), for Pat Example, started Thu Nov 19, 7:30 AM \\(change chg_`));
  assert.equal(await countOf(db, "time_entries"), 1);
  const listed = await ok(c, "list_time", {});
  assert.match(listed.headline, /^1 h 30 min this week \(Mon Nov 16 to Sun Nov 22\): 1 h 30 min billable, \$142\.50\.$/);
});

test("start_timer under apply small applies", async () => {
  const { db, c } = await setup();
  await ok(c, "update_settings", { aiEdits: "apply_small" });
  const started = await ok(c, "start_timer", { deal: "dl_seed01", workType: "Design" });
  assert.match(started.headline, /^Started a timer at 10:00 AM: Design, for "Website refresh for Example Plumbing" \(Pat Example\) \(change chg_/);
  const { entryId } = started.data as { entryId: string };
  assert.match(entryId, /^te_/);
  assert.equal(await countOf(db, "proposals"), 0);

  // stop_timer without a next step applies at once too; with one it is a proposal.
  const withNext = await okText(c, "stop_timer", { notes: "Done for now.", nextStepDate: "2026-11-20" });
  assert.match((withNext.data as { proposal: string }).proposal, /^pr_/);
  assert.equal(await countOf(db, "proposals"), 1);
  const stopped = await ok(c, "stop_timer", { notes: "Done for now." });
  assert.match(stopped.headline, /^Stopped the timer: 1 min, Design, billable at \$95\.00\/h \(\$1\.58\), for "Website refresh for Example Plumbing" \(Pat Example\); logged a note \(change chg_/);
  assert.deepEqual(Object.keys(stopped.data as object).sort(), ["activityId", "changeId", "entryId"]);
});

test("a proposed stop keeps the time it was asked for", async () => {
  const db = await timeDb(NOW);
  const later = new Date(NOW.getTime() + 90 * 60_000);
  let clock = NOW;
  const c = await connectInMemory(createMcpServer({ db, now: () => clock }));
  await db.prepare("INSERT INTO time_entries (id, contact_id, started_at, work_type_id, billable, version, created_at, updated_at) VALUES ('te_running', 'ct_seed01', ?, 'wt_design', 1, 1, ?, ?)")
    .bind(new Date(NOW.getTime() - 60 * 60_000).toISOString(), NOW.toISOString(), NOW.toISOString())
    .run();
  const proposed = await okText(c, "stop_timer", {});
  assert.match(proposed.headline, /\nTime\n- Time 1 h, Design, billable at \$95\.00\/h \(\$95\.00\), for Pat Example\n/);
  // The owner says yes an hour and a half later: the entry still ends when they asked.
  clock = later;
  await ok(c, "apply_changes", { proposal: (proposed.data as { proposal: string }).proposal });
  const row = await db.prepare("SELECT ended_at, minutes FROM time_entries WHERE id = 'te_running'").first();
  assert.deepEqual({ ...row }, { ended_at: NOW.toISOString(), minutes: 60 });
});

test("work types and client rates write at once, and list_work_types lists them", async () => {
  const { db, c } = await setup();
  const added = await ok(c, "add_work_type", { name: "Copywriting", hourlyRate: 80 });
  assert.match(added.headline, /^Added work type Copywriting at \$80\.00\/h, billable by default \(change chg_/);
  assert.match((added.data as { workTypeId: string }).workTypeId, /^wt_/);
  assert.match((await ok(c, "update_work_type", { workType: "Copywriting", hourlyRate: 85 })).headline, CHANGE_LINE);
  assert.match((await ok(c, "set_client_rate", { workType: "Design", contact: "Pat Example", hourlyRate: 120 })).headline, CHANGE_LINE);
  assert.equal(await countOf(db, "proposals"), 0);
  const listed = await ok(c, "list_work_types");
  assert.equal(listed.headline, "3 work types.");
  const types = (listed.data as { workTypes: { name: string; clientRates: unknown[] }[] }).workTypes;
  assert.deepEqual(types.map((w) => w.name), ["Design", "Admin", "Copywriting"]);
  assert.deepEqual(types[0]?.clientRates, [{ contactId: "ct_seed01", contact: "Pat Example", hourlyRate: 120 }]);
});

test("update_time_entry and list_time over MCP", async () => {
  const { db, c } = await setup();
  await ok(c, "update_settings", { aiEdits: "apply_small" });
  db.exec(
    "INSERT INTO time_entries (id, contact_id, started_at, ended_at, minutes, work_type_id, billable, rate, version, created_at, updated_at) " +
      "VALUES ('te_seeded', 'ct_seed01', '2026-11-16T17:00:00.000Z', '2026-11-16T18:00:00.000Z', 60, 'wt_design', 1, 95, 1, 'x', 'x')",
  );
  const proposed = await okText(c, "update_time_entry", { entry: "te_seeded", minutes: 45 });
  assert.match(proposed.headline, /\nTime\n- Time 45 min, Design, billable at \$95\.00\/h \(\$71\.25\), for Pat Example: was 1 h, Design, billable at \$95\.00\/h \(\$95\.00\), for Pat Example\n/);
  const week = await ok(c, "list_time", { period: "this_week" });
  assert.match(week.headline, /^1 h this week \(Mon Nov 16 to Sun Nov 22\): 1 h billable, \$95\.00\.$/);
  const range = await ok(c, "list_time", { from: "2026-11-01", to: "2026-11-15" });
  assert.equal(range.headline, "No time from Sun Nov 1 to Sun Nov 15.");
  assert.match(await fails(c, "list_time", { period: "this_week", from: "2026-11-01", to: "2026-11-15" }), /^Give a period or from and to, not both\.$/);
  assert.match(await fails(c, "list_time", { from: "2026-11-01" }), /^Give both from and to/);
  assert.equal(await fails(c, "list_time", { from: "2026-02-30", to: "2026-03-01" }), '"2026-02-30" isn\'t a date I can read. Use YYYY-MM-DD, for example 2026-11-16.');
  const data = week.data as { entries: unknown[]; running: unknown };
  assert.equal(data.entries.length, 1);
  assert.equal(data.running, null);
});
