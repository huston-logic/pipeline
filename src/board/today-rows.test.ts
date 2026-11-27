// A deal's next step from outside (an import) is labelled on Today's deal row.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { DealItem } from "../services/read.ts";
import { dealRow } from "./today-rows.ts";

const deal = (untrusted: DealItem["untrusted_fields"]): DealItem => ({
  id: "dl_aaaaaaaaaaaa",
  title: "Website",
  contactId: "ct_aaaaaaaaaaaa",
  contactName: "Pat Example",
  stageKey: "call_booked",
  stageLabel: "Call booked",
  status: "open",
  value: null,
  nextStep: "Send the quote",
  nextAt: "2026-11-26T20:00:00.000Z",
  nextAtLocal: null,
  overdue: false,
  lastActivityAt: null,
  stageEnteredAt: "2026-11-01T00:00:00.000Z",
  untrusted_fields: untrusted,
});

const OPTS = { now: new Date("2026-11-26T18:00:00.000Z"), tz: "America/Los_Angeles", showBelongs: true };

test("an outside next step wears the From outside label on Today's deal row; the owner's does not", () => {
  const outside = dealRow(deal(["nextStep"]), OPTS).value;
  assert.match(outside, /<p>Next step: <span class="outside">From outside<\/span> <span class="outside-value">Send the quote<\/span><\/p>/);
  assert.match(dealRow(deal([]), OPTS).value, /<p>Next step: Send the quote<\/p>/);
});
