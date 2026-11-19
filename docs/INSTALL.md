# Installing a copy for a client

This is for the person who sets up and looks after client copies of the pipeline (the repo owner). Each client gets
their own copy: their own Worker, database and sign-in, in **their own Cloudflare account**. The code is the same for
every copy; what differs lives in the client's account and in a git-ignored folder on your Mac, `/.copies/<name>/`.

Steps marked **check in the dashboard** could not be confirmed from Cloudflare's docs when this was written; the goal
of the step is what matters. Decision 0007 explains why it works this way.

Throughout, `<name>` is a short name you pick for the copy (lowercase letters, digits and dashes, for example
`acme`), and `<copy host>` is the address the copy answers on.

## 1. What you need

- This repo, with its packages installed: `npx --yes npm@10.9.9 ci` (README, "Develop").
- Node 22.19 or later.
- Wrangler logged in as **you**, in your own terminal: `npx wrangler login`. Check it with `npx wrangler whoami`.
- The client's email address(es) that should be able to sign in (the "owner emails").
- A decision on the address: a custom hostname on a domain in the client's Cloudflare account (recommended, for
  example `pipeline.clientdomain.com`), or the free `workers.dev` address.

## 2. Get invited to the client's Cloudflare account

You never ask for the client's password or an API token. Instead the client adds you as a member of their account:

1. The client opens the Cloudflare dashboard, then **Manage Account** > **Members** > **Invite**. **Check in the
   dashboard** for the exact place.
2. They enter your Cloudflare login email and pick a role that can edit Workers, D1, KV and Zero Trust (for example
   Administrator). **Check in the dashboard** for the role names.
3. You accept the invitation from the email Cloudflare sends.
4. Run `npx wrangler whoami`: the client's account should now be in the list, with its account id.

If the client ever removes you, `npm run copies:update` stops for their copy and says so.

## 3. Set up sign-in (Cloudflare Access)

Follow [docs/ACCESS-SETUP.md](ACCESS-SETUP.md) steps 1 to 4 in the client's account, using `<copy host>`. Keep the
five values from step 1 at hand (in a password manager) for the secrets in step 4 below, and note the **team domain**
and the board application's **AUD tag** from step 4 of that page. Skip its steps 5 and 6: provisioning does them.

## 4. Provision the copy

```bash
npm run copies:provision -- --copy <name>
```

It asks for:

- **the account**: it lists the accounts your login can use; type the number of the client's;
- **owner email(s)**: who may sign in, comma-separated;
- **the Access team domain** and **AUD tag** from step 3;
- **where the copy answers**: `workers.dev`, or the custom hostname;
- **a "from" address for the daily brief** (optional; press Enter to leave the brief unsent).

Then it creates, in the client's account: the production database `pipeline-<name>`, the preview database
`pipeline-<name>-preview`, and two KV namespaces for sign-in (`pipeline-<name>-oauth` and `-oauth-preview`). It
writes the copy's config to `.copies/<name>/wrangler.jsonc` (with `copy.json` beside it: what was done, for
`--resume`), sets up both databases (migrations, default stages and the starter rulebook) and stores the owner emails
in both (so you can also sign in to a preview deployment). Wrangler shows the migrations and asks you to confirm
them: answer yes. If you answer no, provisioning stops there and `--resume` asks again.

Last, it offers to set each secret. For each one, press Enter and wrangler asks for the value; paste it (nobody else
sees it). Type `s` to skip one; the end of the run lists the commands for the skipped ones. The secrets:

| Secret | Value |
|---|---|
| `ACCESS_CLIENT_ID`, `ACCESS_CLIENT_SECRET`, `ACCESS_TOKEN_URL`, `ACCESS_AUTHORIZATION_URL`, `ACCESS_JWKS_URL` | The five values from ACCESS-SETUP.md step 1 |
| `INTAKE_SECRET` | A long random value for the website form (for example from `openssl rand -hex 32`); see step 7 |
| `RESEND_API_KEY` | Only asked when you gave a brief "from" address; see docs/SECRETS.md |

Wrangler may ask whether to create the Worker so it can hold the secrets; say yes (the first deploy fills it in).

If anything fails halfway, fix the cause and run the same command with `--resume` added: it skips what is done.
To see what it would do first, add `--dry-run` (it creates and writes nothing). Never commit anything under
`.copies/`: it holds the client's ids (`npm run check:config` fails if you do).

## 5. First deploy

```bash
npm run copies:update -- --copy <name>
```

It checks your login can use the client's account, builds, applies the database migrations and deploys. Updating
later works the same way: [docs/UPDATING.md](UPDATING.md).

## 6. Check sign-in and connect an AI app

1. Do [ACCESS-SETUP.md](ACCESS-SETUP.md) step 7 ("Check it"): the board opens for an owner email only.
2. In the AI app (for example Claude), add a custom connector (a remote MCP server) with the address
   `https://<copy host>/mcp`. The app opens a page "Allow <app name> to use your pipeline?"; select **Allow**, sign in
   with the owner email and the code Access sends, and the app is connected.
3. Ask it "What's in my pipeline?".

## 7. Connect a website form

The client's website server posts each enquiry to `https://<copy host>/intake` with the `INTAKE_SECRET` value in the
`X-Intake-Secret` header. The README's "Connect a website form" section has the request format. The secret must stay
on the website's server, never in a web page.

## 8. Import the client's existing contacts

Ask the client for a CSV with a header row. The columns used are `name`, `email`, `phone`, `business`, `source` and
`notes` (any order, any capital letters); other columns are ignored and listed. An export from the board or from
`copies:export` works as it is.

First a dry run, which changes nothing:

```bash
npm run import:contacts -- --file path/to/contacts.csv --copy <name>
```

It shows how many contacts would be added, which contacts already on file (same email, ignoring capitals) would get
empty details filled in (nothing is ever overwritten), and which lines would be skipped and why. When it looks right,
import it:

```bash
npm run import:contacts -- --file path/to/contacts.csv --copy <name> --apply
```

The import is one change in the change log: the AI app can undo it with the change id it prints. Imported text is
treated as outside text (like a website form), so the AI never follows instructions written in it. A very large file
is refused with a message to split it; import the parts one by one.

## 9. Export

```bash
npm run copies:export -- --copy <name>
```

It writes every table as JSON and CSV, plus `all.json` (the same shape as the board's export download), into
`exports/<name>-<date>/` (a second export on the same day goes to `exports/<name>-<date>-2/`, and so on, so an
earlier export is never overwritten). The files hold the client's data: keep them private. `exports/` is git-ignored. The board's
Export page offers the same download to the client.

## Removing someone's access

Owner emails are in the copy's database, never changeable through the AI app (decision 0005). To change them, run a
SQL update against the copy's database, for example:

```bash
npx wrangler d1 execute DB --remote -c .copies/<name>/wrangler.jsonc --command "UPDATE settings SET owner_emails = '[\"owner@example.com\"]', version = version + 1 WHERE id = 1"
```

and remove the email from the Access policies (ACCESS-SETUP.md steps 1 and 2).
