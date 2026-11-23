# 0036: Import people on the board

Run 5, task I3, 2026-11-23. Builds on 0014 and 0017 (the board's write path), 0018 (board forms), 0029 (leads in the
import), 0034 (the import engine) and 0035 (one change at any size).

## Context

Until now only the owner's Mac could import a CSV (`npm run import:contacts`). The run asks for the same import on the
board, for People: upload a file, match its columns, check what will happen, apply it as one audited change, and undo
it. The engine had the `notes` and `new_field` targets in its type but refused them. A board form had only ever been
`application/x-www-form-urlencoded` of at most 128 KB, a mapping step needs the file between requests, and the file is
outside text that must not leak into an address, a cookie, a log or a page.

## Decision

- **Steps.** `GET /import?module=people` (step 1 of 3): a file input and a paste box in one `multipart/form-data`
  form, and how to save a CSV from Google Sheets and Excel. `POST /import` stores a draft and answers 303 to
  `/import/<id>` (step 2 of 3): one card per column with its header (escaped, labelled "From your file"), a select
  (each built-in field, each live contact field, New field, Add to notes, Don't import; pre-selected by `autoMatch`), an
  empty label box, and "New people come in as: Contacts / Leads" (Leads when Import was
  tapped on Leads). `POST /import/<id>/map` saves the matches and answers 303 to `/import/<id>/preview` (step 3 of 3):
  the counts, the fields that will be created, the skipped lines with their reasons, the first 20 line numbers of each
  list (people already on file and possible duplicates by their contact link), "Import possible duplicates too" when
  there are any, and Import. `POST /import/<id>/apply` plans again against the data now, writes one change and answers
  303 to `/import/<id>?change=<id>`, where the same page shows the counts, the change banner and Undo. Import buttons
  sit on Contacts and Leads, and Import is in More after Export.
- **Multipart on one route.** A route marked `upload` (only `POST /import`) accepts `multipart/form-data` and nothing
  else; every other route still refuses it (415). The raw body is capped at `UPLOAD_MAX_BYTES` (1 MB plus 64 KB for the
  other fields and the framing) before it is parsed (413 with the split-the-file message), and the CSRF token is read
  from its form part. A file and pasted text are alternatives: both, or neither, is refused in plain English.
- **Drafts** (migration 0010). `import_drafts` holds the module, the mapping, the options (`asLeads`), and once applied
  the counts (`result`) and the change id; `import_draft_parts` holds the file in pieces of at most `CHUNK_BYTES`,
  never cut inside a character. Drafts are scratch space like `write_guard`: not audited, not exported, never logged.
  Ids use the new prefix `im`. A draft expires 2 hours after upload; every import post and the hourly run delete
  expired drafts (the hourly job is last and best effort). The import's GET pages never write: they just don't show an
  expired draft. An expired, finished-and-expired or unknown draft is a 404 page, "This import has finished or
  expired", pointing to Changes and to Start again. The file is in no address, cookie, log line or page; a page shows
  only its header names (each in its own column's legend, labelled), line numbers and counts.
- **Columns by number in every message.** A header cell is outside text, so no refusal or skip reason quotes it, and
  none can become a link's text in the error summary: the engine and the board name a column by its number ("column
  3"), a built-in column by its key, a field by its label (`Line 2's value in column 2 is 51 KB`, `the "Team size"
  field needs a number`, `Column 3 goes to a field that isn't a contact field you can fill`). The CLI's messages
  changed the same way, since it uses the same engine.
- **Apply once.** The apply batch starts with a guard that the draft is still unapplied, unexpired and at the version
  the preview showed (`ChangeInput.leading`, before any row write), and ends with the result, the change id and the
  deletion of the file. A second apply (a double tap, the back button) sees the result and redirects to it. Two applies
  racing write one change: the loser's batch fails at the guard, and whatever made it fail, the loser reads the draft
  again and shows the winner's result. An import that would write nothing is marked applied with its counts and no change. Apply refuses, as a 422
  page with nothing written: a mapping that no longer fits (a field archived since), a person changed or an email added
  while importing, and a person on file too large to fill in one statement (`RecordTooLargeError` from `chunkBy`,
  carried from 0035), never a 500.
- **Add to notes.** Each such column adds `Label: value` lines to the person's notes, after a notes column's value, in
  column order; the label is the label box's, or the column's header when the box is left empty (notes are outside
  text either way). A person on file gets only the lines their notes don't
  already hold, after what is there, so importing the same file twice adds nothing. Notes that would pass 10,000
  characters skip the row ("notes is longer than 10000 characters"). Notes stay outside text.
- **New field.** Each such column creates a text field on contacts, labelled with what the owner types in the label box
  (it starts empty, and a New field without a label is refused on the matching step, so a header never becomes a
  trusted field label on its own), with `add_field`'s
  rules (`newFieldRow` in `src/services/fields.ts`: the label checked, a live field with the same label refused, the
  key slugged and never reusing an archived key). A label whose key a live field already has is refused on the
  matching step: the owner should choose that field instead. The field rows are inserted first in the import's own
  change, so one Undo removes the people and the fields; a field is never added alone. The summary counts them:
  "Imported 2 contacts and filled details on 1; added 1 contact field".
- **Undo after a merge.** The field-in-use check of an undo ignores rows the same undo puts back to a `before` without
  that key, so undoing an import that created a field and filled it on people already on file succeeds. A person
  outside the import who uses the field since still blocks it.
- **A hand-made mapping is checked.** `mapRows` refuses, in plain English and naming the column by number, a field target that
  isn't a live field of the module's entity, a mapping whose length differs from the header's, a blank or too long
  notes label, and a target chosen twice. The matching step answers each with a 422 that points at the column's
  select or label box and keeps every choice.
- **Judgment calls.** At most 100 columns per file (`IMPORT_MAX_COLUMNS`), so the matching step stays a page a phone can
  scroll. Rows split by tabs (cells copied straight from a spreadsheet), a spreadsheet file (`.xlsx`, `.xls`, `.ods`,
  `.numbers`) and a file with a NUL byte are refused with how to save a CSV instead, since the import reads CSV only.
  The matching step needs one column on Name and says so in board words.

## Why

- A draft in D1 is the only place the file can wait between steps without putting outside text in a URL or cookie, and
  pieces under `CHUNK_BYTES` keep every statement under D1's 100 KB, like the bulk change.
- Planning again at apply means the import never writes against a stale picture of the people on file; the preview is
  a forecast and the result shows what was written.
- One guarded batch for the change and the draft makes "applied" and "written" the same fact, so no tap order can
  write twice.
- Creating new fields inside the import's change keeps one import one undo (0035).

## Consequences

- CPU: the preview and the apply each read every contact and plan the file once. On a big copy a full 2,000-row file
  can pass the free plan's 10 ms (0035, docs/PAID-PLAN.md); the CLI import stays the way around it.
- A draft's file sits in D1 for up to 2 hours if the owner walks away; the hourly run removes it.
- Only People can be imported on the board. Deals and tasks need their own modules and a `module=` value; the drafts
  table already allows them.
- `npm run test:a11y` can't run on this Mac (no Playwright Chromium); CI runs it. The four import pages are in
  `boardRoutes`, so the a11y check, Lighthouse and the screenshots visit them, using the seed's drafts `im_seed01` to
  `im_seed03`, which never expire.
