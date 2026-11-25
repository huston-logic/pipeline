# 0007: Many copies: provisioning, the update command, import and export

Partly replaced by [0054](0054-managed-hosting.md): copies now live in the repo owner's own Cloudflare account, so the
client-invites-the-owner steps below no longer apply. The commands, checks and file layout stand.

## Context

The spec asks for an install path (a provisioning script that creates the production and preview databases, applies
migrations, prompts for secrets and seeds the defaults, writing nothing client-specific into tracked files), an update
path that brings every copy to a new version "with one command or one workflow, with no client identifiers in the
repo", a CSV contact import with a dry run, and a full export by script. It left open who runs the update and with
which credentials, how per-copy config is made, how the import writes through the audited service layer when it runs
outside the Worker, and the shape of the export files.

## Decision

- **One update command, run by the repo owner.** `npm run copies:update [-- --copy <name>] [--dry-run]`
  (`scripts/copies.mjs update`). Each client invites the repo owner's Cloudflare user into their own Cloudflare
  account; the owner runs the command from this repo with their own `wrangler login`. No client API token is stored
  anywhere. For each copy in `/.copies/*/copy.json` (or the one named) the command:
  1. checks once per run that `wrangler whoami --json` lists the copy's `account_id`, and stops that copy if not;
  2. runs `npm run build` once per run (a failed build stops everything before any copy changes);
  3. applies the migrations with `wrangler d1 migrations apply DB --remote -c .copies/<name>/wrangler.jsonc`, then
     checks with `wrangler d1 migrations list` that none is still pending. The apply asks the owner to confirm, which is
     worth keeping (they see what will run), but a "no" exits 0, so the exit code alone can't be trusted; a pending
     migration stops that copy with "migrations not applied; not deployed";
  4. deploys with `wrangler deploy -c .copies/<name>/wrangler.jsonc` (only when the migrations are all applied);
  5. prints one line per copy (`<name>: updated` or `<name>: FAILED: <why>`), goes on past a failed copy, and exits
     non-zero at the end if any failed.
  Every command sets `CLOUDFLARE_ACCOUNT_ID` to the copy's account. The account checked is the `account_id` in the
  copy's `wrangler.jsonc` (where wrangler deploys); a copy whose config and `copy.json` name different accounts is
  refused. A copy with any provisioning step except the secrets still to do is refused too.
  `--dry-run` prints the commands and runs nothing.
- **Not Workers Builds or GitHub Actions.** Either would need each client's account id or an API token for it in this
  public repo or in its secrets, and a CI job deploying into many client accounts is a much bigger blast radius than
  one person's interactive login. This repo is not connected to Workers Builds; merging into `main` deploys nothing.
- **Provisioning** (`npm run copies:provision -- --copy <name>`) asks for (or takes as flags) the account (offering
  the ones `wrangler whoami --json` lists), the owner email(s), the Access team domain and AUD tag, workers.dev or a
  custom hostname, and an optional `BRIEF_FROM`. Then, each step recorded in `copy.json` once done:
  D1 `pipeline-<name>` and `pipeline-<name>-preview`; KV `pipeline-<name>-oauth` and `pipeline-<name>-oauth-preview`
  (each found by name with `d1 list --json` / `kv namespace list` before it is created, so a rerun never makes two);
  Rate Limiting namespace ids (1001-1004, or the next free block of ten when another copy uses the same account);
  `.copies/<name>/wrangler.jsonc` from `config/wrangler.copy.template.jsonc` (paths relative to the copy folder; on a
  custom host a `custom_domain` route and `MCP_ALLOWED_HOSTNAMES`); migrations and `seed/defaults.sql` on both
  databases (`--preview` reaches the preview database through `preview_database_id`), each migrate step marked done only
  once `migrations list` shows nothing pending; the owner emails into `settings.owner_emails` on both databases
  (escaped SQL, version bumped; decision 0005), so a preview deployment can be signed in to; then `wrangler secret put` for
  each secret in `docs/SECRETS.md` the copy needs, each one skippable. A second run for the same copy is refused
  unless `--resume`, which skips the steps already done. Owner emails go only in the database, not in an
  `OWNER_EMAILS` var, so removing an owner is one change in one place.
- **Import** (`npm run import:contacts -- --file <csv> (--copy <name> | --local) [--apply]`). `planImport` in
  `src/import/plan.ts` (pure) needs a header row (name, email, phone, business, source, notes; any case; other
  columns are listed as not imported), drops a byte order mark, strips the export's formula-guard apostrophe only
  before `= + - @`, tab or CR, matches existing contacts by email ignoring case, creates the rest, and for a match
  fills only the fields that are empty (never overwrites). Rows with no name, a bad email, an email already used
  earlier in the file, or a value over the MCP tools' limits (500 characters, notes 10,000) are skipped with their
  line number. The default is a dry run that prints the counts and the first 20 of each list. `--apply` builds one
  change (actor `owner`, tool `import`, summary "Imported N contacts and filled details on M (change chg_…)", counts
  only) with the services' own statement builder: `commitChange` was split into `buildChange`, which returns the
  write_guard checks, row writes and audit row as SQL with bound values, and the batch. `src/import/sql.ts` renders
  those values as literal SQL (text with `'` doubled, NULL, integers and finite reals; any other type, a NUL character
  or an unsafe integer is refused). The file goes into the git-ignored copy folder (or `.wrangler/` for `--local`),
  is run with `wrangler d1 execute --file`, and is removed. Every imported field is listed in `untrusted_fields`.
  `undo_change` reverses the import like any other change.
- **Export** (`npm run copies:export -- --copy <name> | --local`). One `wrangler d1 execute DB --json --command
  "SELECT * FROM <table> ORDER BY rowid"` per table in `EXPORT_TABLES` (the board's list), plus `PRAGMA table_info`
  for an empty table so its CSV keeps a header. Files: `exports/<copy>-<owner's local date>/<table>.json` and
  `<table>.csv` (the board's `toCsv`, with the formula guard), and `all.json` in the board's `/api/export.json` shape
  (`{ exportedAt, tables }`).
- **Tests never reach Cloudflare.** Every outside command goes through `run(cmd, options)` in
  `scripts/wrangler-run.mjs`; the tests pass a recorder backed by an in-memory fake (`tests/helpers/wrangler-stub.mjs`)
  and check the exact command sequences. `PIPELINE_WRANGLER` points the real scripts at that stub as a program, and
  `PIPELINE_COPIES_DIR` / `PIPELINE_EXPORTS_DIR` at scratch folders, for demonstrations.

## Why

An interactive login that is a member of each client's account is the only option with no client identifier or
credential stored outside the owner's own machine, and wrangler already supports it (`whoami` lists the memberships).
Checking membership first gives a plain message instead of a confusing permission error halfway through. Keeping each
copy's config in its own git-ignored folder, generated from one tracked template, keeps the code identical across
copies and the repo free of client values; a test keeps the template's shared settings in step with `wrangler.jsonc`,
and `npm run check:config` checks the template holds placeholders only. Reusing the services' statement builder for
the import means the import cannot drift from what `commitChange` writes: a test applies the rendered file and the
service to two databases and compares every row and the audit entry.

## Consequences

- The owner's Cloudflare user must be a member of every client account (with a role that can edit Workers, D1 and KV),
  and must keep that membership for updates. A client who removes it stops getting updates; `copies:update` says so.
- `copies:update` never rewrites a copy's `wrangler.jsonc` (an owner may have edited it, for example `BRIEF_SENDING`).
  A release that adds a binding or variable to the template must say so in its notes, and each copy's config is then
  edited by hand (or provisioned again). Revisit with a config merge command if that happens often.
- Migrations are forward-only and run before the deploy, so a failed deploy leaves a database one version ahead of
  its code; migrations here only add, so the older code still runs (docs/UPDATING.md). A migration that removes or
  renames something needs a two-release plan.
- The update applies migrations to the production database only. Previews share the preview database, whose
  migrations the owner applies with `--preview` when testing a release there first (docs/UPDATING.md).
- `wrangler d1 execute --file` runs a local file in one batch (all or nothing; checked against wrangler 4.160.1's
  source). Remote, it uses D1's import API, and wrangler prints for it: "if the execution fails to complete, your DB
  will return to its original state and you can safely retry" (wrangler 4.160.1). So a failure anywhere in the file
  (a stale contact failing its write_guard check, or a duplicate email added between the read and the write) leaves
  the database as it was, with no partial import and no audit row. Confirm that on the first real import.
- One import is one change, so its audit row holds every row it writes; D1 allows 100 KB per statement, so a very large
  CSV (roughly a few hundred contacts with notes) is refused with "split the CSV". The board's export is one batch,
  so its tables come from one moment; the script reads table by table, so a write during an export can show in one
  table and not another.
- The spec said the provisioning script is "used with the client's own wrangler login"; it works with any login that
  is a member of the client's account, which with this decision is normally the repo owner's.
