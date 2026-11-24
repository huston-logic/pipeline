// The record write tools' inputs (add_lead, add_deal, add_contact, update_contact, update_deal, qualify_lead,
// return_to_lead, log_activity, add_task, complete_task, snooze_task). tools-write.ts registers each tool with its
// schema, and a proposal's action is the same object plus `action` (src/services/proposal-actions.ts, decision 0044).
import { z } from "zod";
import { CONTACT_TYPES } from "../services/activities.ts";
import { LEAD_STATUSES } from "../services/lead-status.ts";
import {
  contactRef,
  DEAL_STATUSES,
  dealRef,
  fieldValues,
  longText,
  orNull,
  shortText,
  statusRef,
  subStatusRef,
  when,
} from "./schemas.ts";

/** Owner-loggable activity types: the contact types without "form", which only comes in through /intake. */
export const LOGGABLE = CONTACT_TYPES.filter((type) => type !== "form") as ["email", "call", "meeting", "note"];

const taskRef = () => z.string().min(1).max(100).describe("The task's id, tk_...");

export const addLeadInput = z.strictObject({
  name: shortText("The person's name. Needed unless business is given.").optional(),
  business: shortText("Their business name.").optional(),
  email: shortText("Their email address. One already on file is refused.").optional(),
  phone: shortText("Their phone number.").optional(),
  source: shortText("Where the lead came from, for example \"referral\" or \"drove past\".").optional(),
  notes: longText("Anything worth remembering, in a few words; logged as a note on the person.").optional(),
  contactFields: fieldValues("contact").optional(),
  allowDuplicate: z.boolean().optional().describe("true to add the lead even though someone on file has the same business."),
});

export const addDealInput = z.strictObject({
  name: shortText("The person's name. Needed unless contact is given.").optional(),
  contact: contactRef(
    "An existing contact to add the deal to: their id (ct_...) or exact name. Their details are left as they are.",
  ).optional(),
  email: shortText("Their email address. A contact already using it gets the new deal.").optional(),
  phone: shortText("Their phone number.").optional(),
  business: shortText("Their business name.").optional(),
  source: shortText("Where the lead came from, for example \"referral\" or \"trade fair\".").optional(),
  notes: longText("What they want, in a few words; logged as a note on the deal.").optional(),
  dealTitle: shortText("The deal's title; the default is \"<name> inquiry\".").optional(),
  value: z.number().min(0).optional().describe("The deal's value, a number of 0 or more."),
  nextStep: shortText("The next step, for example \"Send a quote\".").optional(),
  nextAt: when("When the next step is due").optional(),
  fields: fieldValues("deal").optional(),
  contactFields: fieldValues("contact").optional(),
});

export const addContactInput = z.strictObject({
  name: shortText("The person's name."),
  email: shortText("Their email address. One already on file is refused.").optional(),
  phone: shortText("Their phone number.").optional(),
  business: shortText("Their business name.").optional(),
  source: shortText("Where they came from, for example \"referral\".").optional(),
  notes: longText("Notes about the person.").optional(),
  personStatus: statusRef("Their person status: its key or label (see list_person_statuses). The default is contact.").optional(),
  subStatus: orNull(
    subStatusRef("One of that status's sub-statuses: its key or label, or null for none (the default; a lead starts New)."),
  ).optional(),
  fields: fieldValues("contact").optional(),
  allowDuplicate: z
    .boolean()
    .optional()
    .describe("With a lead: true to add them even though someone on file has the same business, as add_lead."),
});

export const qualifyLeadInput = z.strictObject({
  contact: contactRef("The lead: their id (ct_...) or exact name."),
  createDeal: z.boolean().optional().describe("false to only set Qualified, with no deal. The default is true."),
  stage: shortText("An open stage for the deal: its key (call_booked) or label (Call booked). The default is the first.").optional(),
  dealTitle: shortText("The deal's title; the default is \"<name> inquiry\".").optional(),
  value: z.number().min(0).optional().describe("The deal's value, a number of 0 or more."),
  nextStep: shortText("The next step, for example \"Send a quote\".").optional(),
  nextAt: when("When the next step is due").optional(),
});

export const returnToLeadInput = z.strictObject({
  deal: dealRef(),
  status: z
    .enum(LEAD_STATUSES)
    .optional()
    .describe("The person's lead status: new, contacted (the default), not_now, not_a_fit or bad. qualified is refused."),
});

export const updateContactInput = z.strictObject({
  contact: contactRef(),
  name: shortText("The new name.").optional(),
  email: orNull(shortText("The new email address, or null to clear it.")).optional(),
  phone: orNull(shortText("The new phone number, or null to clear it.")).optional(),
  business: orNull(shortText("The new business name, or null to clear it.")).optional(),
  source: orNull(shortText("Where the lead came from, or null to clear it.")).optional(),
  notes: orNull(longText("Notes about the person, or null to clear them.")).optional(),
  fields: fieldValues("contact").optional(),
  leadStatus: z
    .enum(LEAD_STATUSES)
    .optional()
    .describe(
      "The lead status: new, contacted, not_now, not_a_fit (a real business, wrong for us) or bad (wrong details, " +
        "closed, duplicate or spam). qualified is refused: use qualify_lead.",
    ),
  followUpDate: when(
    "With leadStatus not_now (or for a lead already Not now): when to check back, which adds the task " +
      "\"Check back with <name>\" due then",
  ).optional(),
  personStatus: statusRef("A new person status: its key or label (see list_person_statuses). Not together with leadStatus.").optional(),
  subStatus: orNull(
    subStatusRef(
      "One of the person status's sub-statuses (the new one, or the current one): its key or label. null clears it " +
        "(not for a lead). Left out, it is kept when the status stays, New for a new lead, none otherwise.",
    ),
  ).optional(),
});

export const updateDealInput = z.strictObject({
  deal: dealRef(),
  stage: shortText("The stage to move to: its key (call_booked) or label (Call booked).").optional(),
  status: z.enum(DEAL_STATUSES).optional().describe("The new status. Ask the owner before won, lost or not_now."),
  title: shortText("The new title.").optional(),
  value: z.number().min(0).nullable().optional().describe("The deal's value, a number of 0 or more, or null to clear it."),
  nextStep: orNull(shortText("The next step, or null to clear it.")).optional(),
  nextAt: orNull(when("When the next step is due, or null to clear it")).optional(),
  fields: fieldValues("deal").optional(),
});

export const logActivityInput = z.strictObject({
  deal: dealRef().optional(),
  contact: contactRef().optional(),
  type: z.enum(LOGGABLE).describe("What kind of contact it was."),
  summary: longText("What happened, in a sentence or two."),
  occurredAt: when("When it happened; the default is now. It can't be in the future").optional(),
});

export const addTaskInput = z.strictObject({
  deal: dealRef().optional(),
  contact: contactRef().optional(),
  title: shortText("What to do, in a few words."),
  dueAt: when("When it is due").optional(),
});

export const completeTaskInput = z.strictObject({ task: taskRef() });

export const snoozeTaskInput = z.strictObject({
  task: taskRef(),
  until: when("When the task should come back; it must be in the future"),
});
