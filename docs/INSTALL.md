# Installing a copy for a client

This is for the person who sets up and looks after client copies of the pipeline (the repo owner). Each client gets
their own copy: their own Worker, database and sign-in, in **their own Cloudflare account**. The code is the same for
every copy; what differs lives in the client's account and in a git-ignored folder on your Mac, `/.copies/<name>/`.

Steps marked **check in the dashboard** could not be confirmed from Cloudflare's docs when this was written; the goal
of the step is what matters. Decision 0007 explains why it works this way.

Throughout, `<name>` is a short name you pick for the copy (lowercase letters, digits and dashes, for example
`acme`), and `<copy host>` is the address the copy answers on.

## 1. What you need

- **First, find out which Cloudflare account owns the client's domain** (the account where the domain shows under
  the client's websites or domains list). Access, the Worker and the custom domain must all live in that one account.
  If the client has more than one Cloudflare account, use that one for every step below.
- This repo, with its packages installed: `npx --yes npm@10.9.9 ci` (README, "Develop").
- Node 22.19 or later.
- Wrangler logged in as **you**, in your own terminal: `npx wrangler login`. It opens a browser page to approve the
  login: approve it in a browser signed in to the Cloudflare login that can use the account owning the domain (yours,
  once the client has invited you in step 2). If the browser is signed in to a different Cloudflare login, wrangler
  gets that one instead (see "Troubleshooting"). Check it with `npx wrangler whoami`.
- The client's email address(es) that should be able to sign in (the "owner emails").
- A decision on the address: a custom hostname on a domain in the client's Cloudflare account (recommended, for
  example `pipeline.clientdomain.com`), or the free `workers.dev` address.

## 2. Get invited to the client's Cloudflare account

You never ask for the client's password or an API token. Instead the client adds you as a member of their account:

1. The client opens the Cloudflare dashboard **in the account that owns the domain** (step 1), then **Manage
   Account** > **Members** > **Invite**. **Check in the dashboard** for the exact place.
2. They enter your Cloudflare login email and pick a role that can edit Workers, D1, KV and Zero Trust (for example
   Administrator). **Check in the dashboard** for the role names.
3. You accept the invitation from the email Cloudflare sends.
4. Run `npx wrangler whoami`: the client's account should now be in the list, with its account id.

If the client ever removes you, `npm run copies:update` stops for their copy and says so.

## 3. Set up sign-in (Cloudflare Access)

Follow [docs/ACCESS-SETUP.md](ACCESS-SETUP.md) steps 1 to 4 in the client's account (the one that owns the domain),
using `<copy host>`. The Zero Trust **Free** plan is enough. Keep the five values from step 1 at hand (in a password
manager) for the secrets in step 4 below, and note the **team domain** and the board application's **AUD tag** from
step 4 of that page. Skip its steps 5 and 6: provisioning does them.

## 4. Provision the copy

```bash
npm run copies:provision -- --copy <name>
```

It asks for:

- **the account**: it lists the accounts your login can use; type the number of the client's;
- **owner email(s)**: who may sign in, comma-separated;
- **the Access team domain** and **AUD tag** from step 3. The team domain is the host only, for example
  `<team>.cloudflareaccess.com`, with no `https://` and no `/` at the end (with them, it asks again). The AUD tag is
  the value labelled **Application Audience (AUD) Tag** on the board application;
- **where the copy answers**: `workers.dev`, or the custom hostname;
- **a "from" address for the daily brief** (optional; press Enter to leave the brief unsent).

Then it creates, in the client's account: the production database `pipeline-<name>`, the preview database
`pipeline-<name>-preview`, and two KV namespaces for sign-in (`pipeline-<name>-oauth` and `-oauth-preview`). It
writes the copy's config to `.copies/<name>/wrangler.jsonc` (with `copy.json` beside it: what was done, for
`--resume`), sets up both databases (migrations, default stages and the starter rulebook) and stores the owner emails
in both (so you can also sign in to a preview deployment). Wrangler shows the migrations and asks you to confirm
them: answer yes. If you answer no, provisioning stops there and `--resume` asks again.

Last, it offers to set each secret, one at a time: `Set <NAME> now? ... [Y/s(kip)]`. Pressing Enter means **yes**,
so read which secret the line names before you paste anything: the prompts come quickly and look alike. After the
yes, wrangler asks for the value; paste the one for that name (nobody else sees it). Type `s` to skip one; the end of
the run lists the commands for the skipped ones. If you pasted a value into the wrong secret, see "Troubleshooting".
The secrets:

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
   with the owner email and the code Access sends, and the app is connected. The email of the AI app's own account
   does not matter: what counts is the owner email you sign in to Access with.
3. Ask it "What's in my pipeline?".

## 7. Connect a website form

The client's website server posts each enquiry to `https://<copy host>/intake` with the `INTAKE_SECRET` value in the
`X-Intake-Secret` header. The README's "Connect a website form" section has the request format. The secret must stay
on the website's server, never in a web page.

## 8. Import the client's existing contacts

There are two ways. The board is the first choice: the client (or you) does it in the browser, with no terminal. The
command line is the second way, for a very big file or when you are working from your Mac.

### The board (first choice)

1. **Get a CSV file.** The import reads CSV only (a plain text file of rows, the first row being the column names).
   - Google Sheets: **File** > **Download** > **Comma-separated values (.csv)**.
   - Excel: **File** > **Save as** > **CSV UTF-8 (Comma delimited) (\*.csv)**.
   - A spreadsheet file (`.xlsx`, `.xls`, `.ods`, `.numbers`) is refused with these same instructions. You can also
     paste rows straight into the page instead of choosing a file.
2. **Open the Import page.** Tap **Import** on Contacts, Leads, Pipeline (deals) or Today (tasks), or open **More** >
   **Import**. On Leads the new people come in as leads; elsewhere as contacts.
3. **Step 1, choose or paste.** Pick the file, or paste the rows, then continue. A file and pasted text together are
   refused; use one.
4. **Step 2, match columns.** Each column of the file gets a box. It is already set to the field it looks like
   (Name, Email, Phone, Business, Source, Notes). Change it to another field, to **Add to notes**, to **New field**
   (type the field's name in the label box) or to **Don't import**. One column must go to Name.
5. **Step 3, check.** The page says how many people would be added, how many already on file would get empty details
   filled in (nothing is ever overwritten), which lines are skipped and why, and which look like duplicates (tick
   **Import possible duplicates too** only if you want them). Nothing is saved yet.
6. **Import.** Tap **Import** to save it. It is one change in the change log.
7. **Undo.** The page after it shows **Undo**. One tap takes back the whole import: the people and any new fields.

Limits: 2,000 rows and 1 MB in one import (split a bigger file and import the parts one after another), and a file is
kept for 2 hours, then thrown away. Everything imported is outside text (like a website form), so the AI app never
follows instructions written in it. If it is the owner's own customer list, tick **This is my own list** on step 3 so
names, businesses, emails, phones and sources show as the owner's own; leave it unticked for a file someone else made
(decision 0038). Deals and tasks import the same way and accept the board's own CSV export. On a copy with a very big
list, a full 2,000-row import can pass the free plan's CPU limit: if it fails with "exceeded CPU", import it from the
Mac (below), split it, or see docs/PAID-PLAN.md ("Run 5: import").

The AI app can do the same: say "Import these people from my sheet". It shows you the preview first and saves only after
you say yes.

### The command line (second way)

The columns used are `name`, `email`, `phone`, `business`, `source` and `notes` (any order, any capital letters); other
columns are ignored and listed. An export from the board or from `copies:export` works as it is.

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

To bring people in as leads (people to approach, not yet talking to), add `--as leads`: the new people get the status
New. A `lead_status` column can set each new person's status instead (it works without `--as leads` too, so a CSV exported
from the board comes back with its statuses), but only when it says exactly `new`, `contacted`,
`not_now`, `not_a_fit`, `bad` or `qualified` (or `New`, `Contacted`, `Not now`, `Not a fit`, `Bad lead`, `Qualified`);
any other value skips that line. People already on file never have their status changed. A column headed like one of
your contact custom fields (its name or label) fills that field for the new people. With `--as leads`, a line with no
email whose business matches someone already on file (or an earlier line) is listed as a possible duplicate and
skipped; add `--allow-duplicates` to import those anyway.

The command line uses the same import engine as the board. One file takes up to 2,000 rows and 1 MB and is applied in
one go as one change in the change log: the AI app can undo it with the change id it prints. A bigger file is refused
with a message to split it; import the parts one by one.

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

## Troubleshooting

**A secret got the wrong value** (for example, Enter said yes to a secret you meant to skip, or you pasted the value
for a different one). Set it again with the right value; the new one replaces the old:

```bash
npx wrangler secret put <NAME> -c .copies/<name>/wrangler.jsonc
```

**The board says "This account isn't allowed to open this board."** The browser signed in to Access with an email
that is not an owner email (often another account the browser was already signed in with). Sign out of Access, then
open the board again and use the owner email:

- Sign out: `https://<team>.cloudflareaccess.com/cdn-cgi/access/logout`
- See which email Access has: `https://<copy host>/cdn-cgi/access/get-identity` (shows a short JSON document; look at
  `email`). Cloudflare's docs give this path on the team domain,
  `https://<team>.cloudflareaccess.com/cdn-cgi/access/get-identity`; **check in the dashboard** which one shows your
  sign-in.

**`npx wrangler whoami` does not list the client's account.** The `wrangler login` page was approved in a browser
signed in to a different Cloudflare login. Run `npx wrangler logout`, sign the browser in to the login the client
invited (step 2), then run `npx wrangler login` again and approve it there.
