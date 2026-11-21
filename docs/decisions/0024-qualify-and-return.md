# 0024: Qualifying a lead and moving a deal back to leads: the calls 0022 leaves open

Run 4, task L3, 2026-11-20. Builds on 0022 (leads on contacts), 0023 (adding leads) and 0009 (changes and undo).

## Context

Task L3 adds `qualify_lead` and `return_to_lead`. 0022 fixes what each one does; it leaves the exact words, the
inputs and a few edge cases open.

## Decision

- **Summaries.** `qualify_lead`: `Qualified <contact label>; added deal "<title>" in <stage>` plus the next step and
  date as `add_deal` shows them, or `Qualified <contact label> (no deal)`. `return_to_lead`: `Moved <contact label> back
  to leads (<Status>); archived <deal label>`. Outside names and titles become ids (`labels.ts`).
- **Qualify inputs.** `createDeal` defaults to true. With `createDeal: false`, any deal detail (stage, title, value,
  next step, next date) is refused rather than silently dropped. A stage that is not open is refused with the open
  stages listed. The deal is built by the same code as `add_deal`'s (`src/services/deal-row.ts`), so its default title
  and the outside-name rule are the same. Qualify takes no notes or custom fields in v1: log a note or use `update_deal`.
- **Who can be qualified.** Only an unqualified lead (any of the five statuses) who is not archived. Anyone else is
  refused and pointed to `add_deal`.
- **Return inputs.** `status` takes the five unqualified keys (default `contacted`); `qualified` is refused in plain
  English by the service (the tool's schema lists every status so the refusal can say why). A Lost or Not now deal can
  be returned too; its status is kept. A Won deal and an archived deal are refused.
- **Tasks.** Every task of the deal that is not done (snoozed ones and rule tasks included) gets `deal_id = null` and
  the deal's contact as its `contact_id`. Done tasks stay on the deal.
- **The same status again.** When the person already has the status asked for (possible only with a closed deal),
  their row is left alone, as `update_contact` does (0023).
- **Invariant 1 in the batch.** `return_to_lead` checks for another open deal before writing and again inside the
  batch (a `write_guard` row). When a guard trips and the person now has another open deal, the owner gets the same
  plain "has another open deal" refusal; any other stale write still says "changed since you read it". A deal whose
  person is archived is refused, as `qualify_lead` refuses an archived person.
- **Undo.** No special code: undoing `qualify_lead` deletes the deal, so a later activity or task on it refuses the
  undo (0009's dependents); undoing `return_to_lead` puts the person's row back, so a later change to them (such as a
  new deal qualifying them) refuses it as "changed since". Undo summaries no longer list `lead_status_at`, which only
  moves with the status.

## Why

- Refusing details the owner gave but that would be thrown away keeps "do what I said" honest.
- One builder for new deals keeps titles and outside-text marking the same everywhere a deal is born.
- Checking the open-deal rule inside the batch is the only way two writers at once can't break invariant 1.

## Consequences

- An archived deal may have status `open`. Every read already skips archived deals, and `openDealCount` does too.
- The board's Qualify form and Back to leads action (task L7) call these services.
