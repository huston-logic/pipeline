import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CLOSED_OUT_STATUSES,
  isLeadStatus,
  isUnqualified,
  LEAD_STATUS_LABELS,
  LEAD_STATUSES,
  leadStatusFromText,
  OPEN_LEAD_STATUSES,
  UNQUALIFIED_STATUSES,
} from "./lead-status.ts";

test("the six statuses are in table order, each with a label", () => {
  assert.deepEqual([...LEAD_STATUSES], ["new", "contacted", "not_now", "not_a_fit", "bad", "qualified"]);
  assert.deepEqual(LEAD_STATUS_LABELS, {
    new: "New",
    contacted: "Contacted",
    not_now: "Not now",
    not_a_fit: "Not a fit",
    bad: "Bad lead",
    qualified: "Qualified",
  });
});

test("groups: unqualified is everything but qualified; open and closed out split the unqualified ones", () => {
  assert.deepEqual([...UNQUALIFIED_STATUSES], ["new", "contacted", "not_now", "not_a_fit", "bad"]);
  assert.deepEqual([...OPEN_LEAD_STATUSES], ["new", "contacted", "not_now"]);
  assert.deepEqual([...CLOSED_OUT_STATUSES], ["not_a_fit", "bad"]);
});

test("isLeadStatus accepts only the six keys", () => {
  for (const key of LEAD_STATUSES) assert.equal(isLeadStatus(key), true, key);
  for (const bad of ["hot", "New", "", null, undefined, 3]) assert.equal(isLeadStatus(bad), false, String(bad));
});

test("isUnqualified: any status but qualified; no status is not a lead", () => {
  assert.equal(isUnqualified("new"), true);
  assert.equal(isUnqualified("bad"), true);
  assert.equal(isUnqualified("qualified"), false);
  assert.equal(isUnqualified(null), false);
});

test("leadStatusFromText takes an exact key or an exact label, trimmed, and nothing else", () => {
  assert.equal(leadStatusFromText("Bad lead"), "bad");
  assert.equal(leadStatusFromText("  Not a fit "), "not_a_fit");
  assert.equal(leadStatusFromText("contacted"), "contacted");
  assert.equal(leadStatusFromText("not_now"), "not_now");
  for (const text of ["Hot", "bad lead", "", "  ", "CONTACTED"]) assert.equal(leadStatusFromText(text), null, text);
});
