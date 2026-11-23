// The Person status and Sub-status fields of the board's person forms (Add contact and Edit contact, decision 0041).
// Plain selects that work without JavaScript: Sub-status lists every live status's sub-statuses in a group under that
// status, with values "<status>.<key>", so a post names the status a sub-status belongs to. A sub-status that isn't
// the chosen status's own is refused with a 422 that says which ones are; the service then gets the key alone.
import type { ContactRow } from "../db/db.ts";
import { joinAnd } from "../services/describe.ts";
import type { PersonStatusView } from "../services/person-status.ts";
import { LEAD } from "../services/person-move.ts";
import { fieldError } from "./action-kit.ts";
import { type Collected, line, type Spec } from "./record-form.ts";

/** The column the Sub-status field reads its stored value from: "<status>.<key>", or "" for none. */
const SUB_REF = "sub_ref";

const live = (statuses: readonly PersonStatusView[]) => statuses.filter((status) => !status.archived);

export function personStatusSpecs(statuses: readonly PersonStatusView[]): Spec[] {
  const groups = live(statuses)
    .map((status) => ({
      label: status.label,
      options: status.subStatuses.filter((sub) => !sub.archived).map((sub) => ({ value: `${status.key}.${sub.key}`, label: sub.label })),
    }))
    .filter((group) => group.options.length > 0);
  return [
    line("person_status", "Person status", "choice", "contact", {
      prop: "personStatus",
      options: live(statuses).map((status) => ({ value: status.key, label: status.label })),
      hint: "What kind of person they are.",
    }),
    line("sub_status", "Sub-status", "choice", "contact", {
      column: SUB_REF,
      prop: "subStatus",
      groups,
      hint: "Pick one listed under the person status you chose. A lead always has one.",
    }),
  ];
}

/** The contact as the person form reads it: with its sub-status as the Sub-status field's value. */
export function personRow(contact: ContactRow): ContactRow & { sub_ref: string } {
  return { ...contact, sub_ref: contact.sub_status === null ? "" : `${contact.person_status}.${contact.sub_status}` };
}

const names = (status: PersonStatusView) => joinAnd(status.subStatuses.filter((sub) => !sub.archived).map((sub) => sub.label));

/**
 * When the form sends a sub-status, checks it is one of the chosen status's own and passes its key on; else marks the
 * field with which ones belong to that status. `chosen` is the status the person will have.
 */
export function checkSubStatus(collected: Collected, chosen: string, statuses: readonly PersonStatusView[]): void {
  const input = collected.input as { subStatus?: string | null };
  if (!Object.hasOwn(input, "subStatus")) return;
  const status = live(statuses).find((entry) => entry.key === chosen);
  if (status === undefined) return;
  const value = input.subStatus ?? null;
  const own = status.subStatuses.filter((sub) => !sub.archived);
  if (value === null) {
    if (status.key === LEAD) fieldError(collected, "sub_status", `A lead always has a ${status.subLabel.toLowerCase()}. Pick one of ${names(status)}.`);
    return;
  }
  const dot = value.indexOf(".");
  const [statusKey, key] = [value.slice(0, dot), value.slice(dot + 1)];
  if (statusKey === status.key && own.some((sub) => sub.key === key)) {
    input.subStatus = key;
    return;
  }
  const picked = statuses.find((entry) => entry.key === statusKey)?.subStatuses.find((sub) => sub.key === key)?.label ?? "That sub-status";
  const message =
    own.length === 0
      ? `${picked} isn't one of ${status.label}'s: ${status.label} has no sub-statuses. Choose None.`
      : `${picked} isn't one of ${status.label}'s. Pick one of ${names(status)}${status.key === LEAD ? "" : ", or None"}.`;
  fieldError(collected, "sub_status", message);
}
