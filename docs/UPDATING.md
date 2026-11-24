# Updating the copies

Every copy runs the code in this repo. When `main` has a new version, you bring every copy up to it with one
command, from this repo on your Mac, logged in to wrangler as yourself (decision 0007; docs/INSTALL.md step 2 has the
account invitation this relies on). Merging into `main` deploys nothing by itself.

## The command

```bash
git switch main && git pull --ff-only
npm run copies:update -- --dry-run      # shows every command, runs nothing
npm run copies:update                   # every copy in .copies/
npm run copies:update -- --copy <name>  # just one
```

What it does, in order:

1. Asks wrangler which accounts your login can use (`wrangler whoami --json`). A copy whose account isn't in that list
   is not touched and is reported as failed ("isn't a member of account ..."): ask that client to invite you again.
2. Builds once (`npm run build`). If the build fails, nothing is updated.
3. For each copy: applies any new database migrations to its production database (wrangler lists them and asks you
   to confirm), checks that none is left pending, then deploys the Worker with the copy's own config
   (`.copies/<name>/wrangler.jsonc`). If the migrations fail, or you answer no, that copy is not deployed
   ("migrations not applied; not deployed").
4. Prints one line per copy, `<name>: updated` or `<name>: FAILED: <why>`, carries on with the next copy, and ends
   with a count. The command exits with an error if any copy failed, so you notice.

It never changes a copy's `wrangler.jsonc`. If a release note says the config template gained a setting, add it to
each copy's config by hand.

The template sets `"preview_urls": false`. A version preview URL runs the new version on the copy's production
bindings (its database, KV and secrets); the `previews` block only covers Worker Previews, so a version preview link
could read and change real client data. Copies provisioned before this setting existed need it added by hand: put
`"preview_urls": false,` in `.copies/<name>/wrangler.jsonc` before the next `npm run copies:update`. To try a release
safely, use the copy's preview database as described below, never a version preview URL.

## Run 4: after you update

Run 4 adds leads (people you approach, kept apart from real deals), email logging, a monthly "What it caught" report
and a phone notification for the daily brief. Do these in order, per copy.

### 1. Update the copy

```bash
git switch main && git pull --ff-only
npm run copies:update -- --copy <name> --dry-run
npm run copies:update -- --copy <name>
```

Migrations 0006 (leads), 0007 (notifications) and 0008 (email log) apply when wrangler asks you to confirm; they only
add tables and columns and keep every row. 0006 also rebuilds the rules and their firings tables under the same names
and adds a "leads" rulebook document to the copy. It never overwrites a rulebook document you already have: a copy
that already has one called "leads" keeps its own words. (Try them on the preview database first if you want to: see
"Before a release that has a new migration" below.)

Access needs no change for these pages: they sit behind the board's sign-in like the rest. The one exception is the
phone: it must be signed in to the board for the notification service worker to install (step 6).

### 2. Reconnect the AI app's connector if the tool list looks stale

New tools: `add_deal`, `qualify_lead`, `return_to_lead`, `list_leads`, and `update_contact` (sets a lead status and a
follow-up date). `add_lead` now means "a person to approach" (a lead, with no deal); a real inquiry uses `add_deal`.
Most AI apps refresh the list by themselves. If yours does not show the new tools, open its connector or integrations
settings, remove the copy's connector and add it again (or use its reconnect or refresh option), then start a new
conversation.

### 3. Sentences to say to the AI app

Say these in the AI app, one at a time. It reads the rulebook first and asks before closing anything.

- **Move an outreach deal back to leads.** "That deal for <business> was never a real opportunity. Put it back in
  leads." For many at once: "List my open deals in New inquiry that never replied, and return each one to leads after
  I confirm the list." Each is one change you can undo.
- **Pause deal rules that were doing outreach.** "Show me my rules." (it uses `list_rules` first) then "Pause the rule
  that reminds me about New inquiry deals." Pausing is not deleting: say "resume" to put it back.
- **Add a lead rule.** "From now on, remind me five days after I contact a lead with no reply." It should preview the
  rule (how many leads it would catch today) and wait for your yes before saving it. It is a `lead_followup` rule.

### 4. Import a list of leads

Dry run first. Nothing is written until `--apply`:

```bash
npm run import:contacts -- --copy <name> --file <csv> --as leads
npm run import:contacts -- --copy <name> --file <csv> --as leads --apply
```

The dry run prints how many people it would add and skip. Lines marked "possible duplicate" look like someone already on
file or earlier in the same file (a row with no email whose business is already there); they are skipped. Check them, and add `--allow-duplicates` only if you want them
anyway. One file takes up to 2,000 rows and 1 MB and is applied in one go (decision 0035); split a bigger list into
files of that size. Each import is one change; ask the AI app to undo it if it was wrong.

### 5. Email logging

Optional, per copy, and a STOP item (it needs DNS and Email Routing in the client's account). Follow
`docs/EMAIL-LOGGING.md`: a log subdomain, the `EMAIL_LOG_ADDRESS` secret, the routing rule to the Worker, then the two
go-live checks in its section 6 (a normal email is logged, and Cloudflare's activity log shows DMARC pass). A strict
DMARC policy (`p=quarantine` or `p=reject`) on your sending domain is recommended. Until the secret is set, the copy
drops every email and the board says so on More > Email logging.

### 6. Notifications for the daily brief

Optional, per copy. Make the copy's keys (nothing is written to a file):

```bash
node scripts/make-vapid-keys.mjs --copy <name> --subject mailto:<owner email>
```

It prints three `npx wrangler secret put ... -c .copies/<name>/wrangler.jsonc` commands (`VAPID_PUBLIC_KEY`,
`VAPID_PRIVATE_KEY`, `VAPID_SUBJECT`) and the value to paste at each prompt. Run each one yourself. Then, on the phone:

1. Open the board in the phone's browser and sign in.
2. Add the board to the Home Screen (iPhone: Share, then Add to Home Screen) and open it from there. An iPhone only
   allows notifications from the Home Screen app.
3. Open More, then Notifications, then Turn on notifications, and allow them when the phone asks.
4. Choose Send a test. A notification should arrive.

A phone that is signed out of Access cannot install or update the service worker, so sign in again if it stops
working. Notifications can be turned off from the same page ("Turn off on this phone").

## Run 5: after you update

Run 5 adds importing people, deals and tasks from a CSV on the board and over the AI app, Person statuses (Lead,
Contact, Partner, and kinds the owner adds), Add a contact, saved views and a table layout for lists. Do these in
order, per copy.

### 1. Update the copy

```bash
git switch main && git pull --ff-only
npm run copies:update -- --copy <name> --dry-run
npm run copies:update -- --copy <name>
```

Migrations 0009 to 0013 apply when wrangler asks you to confirm: they add tables and columns (bigger audit records, import drafts, person
statuses and sub-statuses, a rulebook document, saved views) and keep every row. People who were leads keep their lead status; each person
gets a Person status (a lead is a Lead, everyone else a Contact). Access needs no change: the new pages sit behind the
board's sign-in like the rest.

### 2. Reconnect the AI app's connector if the tool list looks stale

New tools: `import_rows` and `apply_import`; `add_contact`; `list_person_statuses`, `add_person_status`,
`update_person_status`, `add_sub_status` and `update_sub_status`; `list_views`, `add_view`, `update_view` and
`archive_view`. `update_contact` can now set a person status and sub-status, and `search_contacts` can filter by them or
by a custom field's value. If your AI app does not show them, open its connector settings, remove the copy's connector
and add it again (or use its reconnect or refresh option), then start a new conversation.

### 3. Sentences to say to the AI app

Say these one at a time. It reads the rulebook first. Every one is a change you can undo ("Undo that").

- **Import a sheet.** "Import these people from my sheet." It sends the rows, shows you what would happen (how many
  new, how many filled in, what is skipped) and saves only after you say yes. "Undo that import" takes back all of it.
- **Add a contact.** "Add Pat Example from the Fernbrook trade show as a contact." A person with no deal and no lead
  status.
- **Add a kind of person.** "Add a new kind of person: Supplier." It then has its own page at `/people?status=supplier`.
- **Make someone a Partner.** "Make Hannah Example a Partner."
- **Give me a view.** "Give me a view of all my partners." It saves a view that shows in the People switch.

On the board: Import is on Contacts, Leads, Pipeline and Today, and in More. A list can show as cards or as a table.

### 4. Retire an old "Contact type" custom field by talking

If the client made their own "Contact type" field (Partner, Supplier, ...) before Person statuses existed, move it over
in three sentences. Nothing is deleted at any step, and each step is undoable.

1. "Show me everyone whose Contact type is Partner." The AI app looks them up (`search_contacts` with the field and its
   value) and lists them. Check the list.
2. "Make them all Partners." The AI app sets each person's Person status to Partner (`update_contact`, one person at a
   time, each its own change). If the kind does not exist yet, say "Add a new kind of person: Supplier" first and repeat
   for each value.
3. "Archive the Contact type field." (`update_field` with archived true.) The field leaves the forms and lists. The
   values stay stored on each person, and "Bring the Contact type field back" (archived false) or Undo restores it.

### 5. Importing a big list on the free plan

A full 2,000-row import in the Worker takes about 11 ms of CPU on a big copy, a little over the free plan's 10 ms
(docs/PAID-PLAN.md, "Run 5: import"). If a board import of a big file fails with "exceeded CPU", split the file, import
it from your Mac (`npm run import:contacts`, docs/INSTALL.md step 8), or move the copy to Workers Paid.

## Before a release that has a new migration

Migrations only go forward: there is no "undo" for a database change. Try a release on a copy's preview database
first:

```bash
npx wrangler d1 migrations apply DB --remote --preview -c .copies/<name>/wrangler.jsonc
```

and check a preview deployment of that copy against it (previews use the preview database, never the production one).
Then run the update.

## Rolling back

If a release misbehaves, deploy the previous version's code:

1. Find the previous release tag or commit: `git tag --sort=-creatordate` (or `git log --oneline`).
2. `git switch --detach <previous tag>`
3. `npm run copies:update -- --copy <name>` (or for every copy). The previous code has no newer migrations, so only
   the deploy runs.
4. `git switch main` when you're done.

This puts the old code back but not the database: any migration the newer release applied stays. Migrations in this
repo only add tables and columns, so older code keeps working with them. If a future release ever needs to remove or
rename something, its notes will say how to roll back.

Data changes made through the AI app are separate: each one can be undone with `undo_change`.

## When something fails

- **"isn't a member of account"**: your login lost access to that client's account. They invite you again
  (INSTALL.md step 2).
- **"wrangler isn't logged in"**: run `npx wrangler login` in your own terminal.
- **"not fully provisioned"**: finish it with `npm run copies:provision -- --copy <name> --resume`.
- **Migrations failed**: wrangler printed the reason above the summary line. Fix it, then update that copy again.
  Nothing was deployed for it.
- **Deploy failed** after the migrations: the database is already on the new version and the old code is still
  running, which is fine for additive migrations. Fix the cause and update that copy again.
