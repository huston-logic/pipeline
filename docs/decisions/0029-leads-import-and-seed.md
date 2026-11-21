# 0029: Leads in the import, export and demo seed

Run 4, task L8, 2026-11-20. Builds on 0022 (leads on contacts), 0007 (copy scripts), 0013 (CSV formula guard) and 0016
(the demo seed). This record settles what 0022 left open for the CSV import and the seed.

## Context

0022 says `import:contacts --as leads` makes new people leads, a `lead_status` column is accepted only when exact, a
column named like a custom field fills it, possible duplicates are listed and skipped, and the demo seed gains about
twelve leads and a rule. It left open the flags, what happens without `--as leads`, which rows the duplicate check
covers, and how the seed stays consistent with 0016.

## Decision

- **Flags.** `--as leads` and `--allow-duplicates`. Any other `--as` value is refused with a plain message.
- **Status.** With `--as leads`, created rows start `new` (`lead_status_at` is the import time). A `lead_status`
  column is read with `leadStatusFromText` (an exact key or label after trimming); an empty cell means "no column
  value". It also applies to created rows without `--as leads`, so a CSV exported from the board comes back with its
  statuses (an empty status stays "not a lead"). A value that does not match skips the row; the reason names the
  column and never repeats the value. A merge never changes a person's status. `lead_status_at` is not a column: the
  time is always the import time.
- **Duplicates.** Only in a leads import: a row with no email whose business matches (trimmed, inner spaces collapsed,
  case ignored: `businessKey`) a person on file, or a row created earlier in the same file, is "possible duplicate"
  and skipped unless `--allow-duplicates`. The dry run says the line number and the existing contact id (or the
  earlier line), nothing else. Rows with an email are matched by email as always. A plain contacts import does not
  look for duplicates, so existing imports (and the board's CSV round trip) behave as before.
- **Custom fields.** A header equal to a contact field's key or label (case-insensitive, trimmed, not archived) fills
  `fields.<key>` on created rows. The built-in columns and `lead_status` win over a field with the same name. Values
  are checked with the field rules (`validateFieldValues`); a bad value skips the row with a reason naming the column
  and its kind of value, never the value itself. A merge fills only custom fields that are empty on the contact (never overwriting), and only
  those values are checked; the dry run lists them with the other fills. Every filled field is listed in the
  contact's `untrusted_fields`. The status column is read only for new people, and a plain import whose new rows get
  a status from the column also runs the possible-duplicate check.
- **Export.** Unchanged code: `SELECT *` already carries `lead_status`, `lead_status_at` and `rule_firings.contact_id`
  in the JSON and in every CSV. Tests now pin that and the CSV round trip.
- **Seed.** Twelve fake leads (`ct_lead01` to `ct_lead12`, example.com/org/net addresses, 555-01xx phones) in every
  status, with `lead_status_at` 2 to 40 days back; a text logged as a note (`{"via":"text"}`), a plain note and some
  reach activities; two "Check back with ..." tasks on the person (one in the future, one overdue); one lead whose
  name, email, phone, business and source came from an import (in `untrusted_fields`); one qualified lead with a deal
  (`dl_seed21`); and a `lead_followup` rule (`ru_seed03`: Contacted, 5 days, owner). Audit rows follow 0016: the
  newest change on a row matches the row as seeded, so six more changes undo cleanly (add_rule, add_lead, import,
  log_activity, update_contact, qualify_lead) and `scripts/seed-dev.test.ts` checks every answer. Existing seeded ids
  and roles are unchanged; the fixture seed (`tests/helpers/fixture-seed.ts`) is untouched. `boardRoutes` gains
  `/contacts/ct_lead03`, a Contacted lead's page, so the accessibility and Lighthouse checks cover a lead page.

## Why

- Making a status column work without `--as leads` keeps an export-then-import round trip lossless.
- Limiting the duplicate check to leads imports leaves the contacts import exactly as it was, and a lead list with
  no email is where "same business, different spelling" comes up.
- Never echoing a bad value keeps outside text out of the dry run's reasons, as 0022 requires of summaries.

## Consequences

- `planImport` takes `{ asLeads, allowDuplicates, fieldDefs }` (optional, default off); the import script reads
  `field_defs` with one more query per run.
- The demo copy's Today, Pipeline and counts include the new leads, tasks and deal; tests that name them were updated.
