// The fields of the time forms, Add time and Edit time (decision 0051), as record-form specs (decision 0018): the same
// specs draw the form and read the post. Person, deal and work type are selects; a name or title that came from outside is
// shown by id (labels.ts), never as text.
import type { Db, TimeEntryRow } from "../db/db.ts";
import { listDeals, searchContacts } from "../db/queries.ts";
import { contactName, isTrusted } from "../services/labels.ts";
import { contactById, dealById, workTypeById } from "../services/lookup.ts";
import { listWorkTypes } from "../services/work-types.ts";
import { line, type Spec } from "./record-form.ts";

export const TIME_NEW_PATH = "/time/new";
export const timeEditPath = (id: string): string => `/time/${encodeURIComponent(id)}/edit`;
export const timeArchivePath = (id: string): string => `/time/${encodeURIComponent(id)}/archive`;
export const TIME_PREFIX = "time";

/** The most people and open deals a select lists. */
const SELECT_MAX = 300;

type Option = { value: string; label: string };

export type TimeChoices = { people: Option[]; deals: Option[]; types: Option[] };

/** The selects' options. What an entry is already linked to is always there, even when it is not in the first 300. */
export async function timeChoices(db: Db, current: Pick<TimeEntryRow, "contact_id" | "deal_id" | "work_type_id"> | null = null): Promise<TimeChoices> {
  const people = (await searchContacts(db, "", { limit: SELECT_MAX })).map((contact) => ({ value: contact.id, label: contactName(contact) }));
  const deals = (await listDeals(db, { status: "open", limit: SELECT_MAX })).map((deal) => ({
    value: deal.id,
    label: isTrusted(deal, "title") ? deal.title : `deal ${deal.id}`,
  }));
  const types = (await listWorkTypes(db)).map((type) => ({ value: type.id, label: type.name }));
  if (current?.contact_id != null && !people.some((option) => option.value === current.contact_id)) {
    const contact = await contactById(db, current.contact_id);
    if (contact !== null) people.push({ value: contact.id, label: contactName(contact) });
  }
  if (current?.deal_id != null && !deals.some((option) => option.value === current.deal_id)) {
    const deal = await dealById(db, current.deal_id);
    if (deal !== null) deals.push({ value: deal.id, label: isTrusted(deal, "title") ? deal.title : `deal ${deal.id}` });
  }
  if (current?.work_type_id != null && !types.some((option) => option.value === current.work_type_id)) {
    const type = await workTypeById(db, current.work_type_id);
    if (type !== null) types.push({ value: type.id, label: type.name });
  }
  return { people, deals, types };
}

const BILLABLE_NEW: Option[] = [
  { value: "", label: "Follow the work type" },
  { value: "1", label: "Billable" },
  { value: "0", label: "Not billable" },
];
const BILLABLE_EDIT: Option[] = BILLABLE_NEW.slice(1);

/** The form's fields. A new entry needs a start; billing can follow the work type there, while an edit shows what is stored. */
export function timeSpecs(choices: TimeChoices, mode: "new" | "edit"): Spec[] {
  return [
    line("person", "Person", "choice", "deal", {
      column: "contact_id",
      prop: "contact",
      options: [{ value: "", label: "No one" }, ...choices.people],
      hint: "Leave this blank when you choose a deal: the deal brings its person.",
    }),
    line("deal", "Deal", "choice", "deal", { column: "deal_id", prop: "deal", options: [{ value: "", label: "No deal" }, ...choices.deals] }),
    line("work_type", "Work type", "choice", "deal", {
      column: "work_type_id",
      prop: "workType",
      options: [{ value: "", label: "None" }, ...choices.types],
    }),
    line("started", "Start", "when", "deal", {
      column: "started_at",
      prop: "startedAt",
      required: true,
      requiredMessage: "Give the start date and time.",
    }),
    line("ended", "End", "when", "deal", { column: "ended_at", prop: "endedAt", hint: "Give an end or the minutes, not both." }),
    line("minutes", "Minutes", "number", "deal", { column: "minutes", prop: "minutes", min0: true, hint: "A whole number, for example 45." }),
    line("billable", "Billable", "choice", "deal", { column: "billable", prop: "billable", options: mode === "new" ? BILLABLE_NEW : BILLABLE_EDIT }),
    line("notes", "Notes", "textarea", "deal", { column: "notes", prop: "notes" }),
  ];
}
