// A new deal row, as add_deal and qualify_lead build it, and how their summaries name it.
import type { ContactRow, DealRow } from "../db/db.ts";
import { newId } from "../ids.ts";
import { dealTitle, isTrusted } from "./labels.ts";
import type { FieldValues } from "./lookup.ts";

export interface NewDeal {
  contactId: string;
  /** The title given, or null for "<name> inquiry". */
  title: string | null;
  /** Who a default title is named after: a person on file, or a name the caller gave. */
  namedAfter: ContactRow | string;
  stageKey: string;
  value: number | null;
  nextStep: string | null;
  nextAt: string | null;
  fields: FieldValues;
  lastActivityAt: string | null;
}

/** An open deal entering its stage now. A default title built from a name that came from outside is outside text too. */
export function newDealRow(input: NewDeal, now: Date): DealRow {
  const stamp = now.toISOString();
  const person = input.namedAfter;
  const name = typeof person === "string" ? person : person.name;
  const outside = input.title === null && typeof person !== "string" && !isTrusted(person, "name");
  return {
    id: newId("dl"),
    contact_id: input.contactId,
    title: input.title ?? `${name} inquiry`,
    stage_key: input.stageKey,
    value: input.value,
    next_step: input.nextStep,
    next_at: input.nextAt,
    status: "open",
    fields: JSON.stringify(input.fields),
    stage_entered_at: stamp,
    last_activity_at: input.lastActivityAt,
    untrusted_fields: outside ? '["title"]' : "[]",
    archived: 0,
    version: 1,
    created_at: stamp,
    updated_at: stamp,
  };
}

/** "deal \"Garage plans\"", or "deal dl_…" when the title came from outside. */
export const dealNoun = (deal: DealRow): string => (isTrusted(deal, "title") ? `deal ${dealTitle(deal)}` : dealTitle(deal));
