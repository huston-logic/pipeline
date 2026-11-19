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
