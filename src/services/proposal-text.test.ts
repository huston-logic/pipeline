import assert from "node:assert/strict";
import { test } from "node:test";
import { buildFixtureSeed } from "../../tests/helpers/fixture-seed.ts";
import { createTestDb } from "../db/sqlite-d1.ts";
import { DEFAULT_TZ } from "../time.ts";
import { type ProposalList, renderProposal } from "./proposal-text.ts";
import { proposeChanges } from "./proposals.ts";

const NOW = new Date("2026-11-19T18:00:00.000Z");

const ANSWERS = (id: string) =>
  `Show this list to the owner as it is. Their answer: "Yes" (call apply_changes with ${id}), "Yes with changes: ..." ` +
  `(send a revised list with replaces ${id}), or "No" (apply nothing).`;

test("the list renders as the owner reads it, empty groups left out", () => {
  const list: ProposalList = {
    add: [
      {
        record: "Lead Dana Example",
        id: "ct_dana",
        fields: [
          { field: "business", to: "Acme Example" },
          { field: "source", to: "referral" },
        ],
      },
    ],
    update: [
      {
        record: 'Deal "Website refresh" (Pat Example)',
        id: "dl_web",
        fields: [
          { field: "stage", from: "New inquiry", to: "Call booked" },
          { field: "next date", from: "(none)", to: "Thu Nov 26, 2:00 PM" },
        ],
      },
    ],
    tasks: [{ record: 'New task "Call Dana back"', id: "tk_call", fields: [{ field: "for", to: "Dana Example" }, { field: "due", to: "(none)" }] }],
    notes: [{ record: "Call with Pat Example", id: "ac_call", fields: [{ field: "", to: "She wants a quote by Friday" }] }],
    time: [],
  };
  assert.equal(
    renderProposal(list, { id: "pr_abcdefghijkl", expiresLocal: "3:40 PM" }),
    [
      "Proposal pr_abcdefghijkl (expires 3:40 PM). Nothing has changed yet.",
      "",
      "Add",
      "- Lead Dana Example: business Acme Example; source referral",
      "Update",
      '- Deal "Website refresh" (Pat Example): stage New inquiry -> Call booked; next date (none) -> Thu Nov 26, 2:00 PM',
      "Tasks",
      '- New task "Call Dana back": for Dana Example; due (none)',
      "Notes",
      "- Call with Pat Example: She wants a quote by Friday",
      "",
      ANSWERS("pr_abcdefghijkl"),
    ].join("\n"),
  );
  const empty = renderProposal({ add: [], update: [{ record: "Lead Pat Example", id: "ct_pat", fields: [] }], tasks: [], notes: [], time: [] }, {
    id: "pr_abcdefghijkl",
    expiresLocal: "9:05 AM",
  });
  assert.equal(empty, ["Proposal pr_abcdefghijkl (expires 9:05 AM). Nothing has changed yet.", "", "Update", "- Lead Pat Example", "", ANSWERS("pr_abcdefghijkl")].join("\n"));
});

test("the sample, planned through the services: the list comes from the rows the plan would write", async () => {
  const db = await createTestDb();
  db.exec(buildFixtureSeed(NOW, DEFAULT_TZ));
  const answer = await proposeChanges(
    { db, now: NOW, actor: "ai", tool: "propose_changes" },
    {
      actions: [
        { action: "add_lead", name: "Dana Example", business: "Acme Example", source: "referral" },
        { action: "update_deal", deal: "Hardware store website", stage: "Call booked", nextAt: "2026-11-26T14:00" },
        { action: "add_task", contact: "@1", title: "Call Dana back" },
        { action: "log_activity", deal: "Morgan", type: "call", summary: "She wants a quote by Friday" },
      ],
    },
    { extraOwnerEmails: [] },
  );
  assert.equal(answer.kind, "proposal");
  if (answer.kind !== "proposal") return;
  assert.equal(
    answer.text,
    [
      `Proposal ${answer.id} (expires 12:00 PM). Nothing has changed yet.`,
      "",
      "Add",
      "- Lead Dana Example: business Acme Example; source referral",
      "Update",
      '- Deal "Hardware store website" (Morgan Demo): stage New inquiry -> Call booked; next date (none) -> Thu Nov 26, 2:00 PM',
      "Tasks",
      '- New task "Call Dana back": for Dana Example; due (none)',
      "Notes",
      '- Call with Morgan Demo about "Hardware store website": She wants a quote by Friday',
      "",
      ANSWERS(answer.id),
    ].join("\n"),
  );
  assert.match(answer.list.add[0]?.id ?? "", /^ct_/);
  assert.equal(answer.list.update[0]?.id, "dl_seed06");
});

test("a single new task's description shows its first 80 characters with an ellipsis, never the whole text", async () => {
  const db = await createTestDb();
  db.exec(buildFixtureSeed(NOW, DEFAULT_TZ));
  const description = `${"a".repeat(100)} tail`;
  const answer = await proposeChanges(
    { db, now: NOW, actor: "ai", tool: "propose_changes" },
    { actions: [{ action: "add_task", contact: "Morgan", title: "Call back", description }] },
    { extraOwnerEmails: [] },
  );
  assert.equal(answer.kind, "proposal");
  if (answer.kind !== "proposal") return;
  assert.match(answer.text, new RegExp(`description ${"a".repeat(79)}…`));
  assert.doesNotMatch(answer.text, /tail/);
});
