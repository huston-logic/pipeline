# Offboarding a client: moving a copy to their own accounts

**Status: Not yet rehearsed.** Nobody has run this end to end. Rehearse it once with a fake copy and a second Cloudflare
account before a real client asks, and fix this file with what you learn. Two things are known gaps, marked **Gap** below.

Under managed hosting (decision 0054) a client's copy lives in your hosting account. On request, you move the copy, its
data and the current code to the client's own Cloudflare and GitHub accounts. Your responsibility for the copy ends at
handover (the terms are in the client agreement, not in this repo). `<name>` is the copy's name in `.copies/`, and
`<new>` is a second name for the new copy (for example `<name>-handover`), so the two config folders never collide.

This repo is public: no client name, email, id or date of handover goes in it. Those go in the master client record.

## 0. Before you start

- The request, in writing, with the handover date you agreed and who at the client does the steps that need their login.
- They need: a Cloudflare account (the free sign-up is enough to start; one copy may need Workers Paid, see
  docs/PAID-PLAN.md), a GitHub account or organisation, a Resend account for their email, and their AI app. The domain
  they send email from is the one already in use.
- Update the copy to the newest `main` first (`npm run copies:update -- --copy <name>`), so the code you hand over
  matches the data. Write down the commit (`git rev-parse HEAD`).
- Ask the client to stop editing from the moment of the export in step 1 until you tell them it is done. A write after
  the export is left behind.

## 1. Full export

```bash
npm run copies:export -- --copy <name>
```

This writes every table as JSON and CSV, plus `all.json`, into `exports/<name>-<date>/` (docs/INSTALL.md, step 9). Also
take the board's **Export** download as a second copy. Check that a few tables' row counts match the board's own lists.
The files hold the client's data: keep them private, and `exports/` is git-ignored.

## 2. The client's Cloudflare account

1. The client signs up, then opens **Zero Trust** and chooses the Free plan and a team name (docs/ACCESS-SETUP.md,
   "Before you start").
2. They invite your login for the move: **Manage Account** > **Members** > **Invite**, with a role that can edit
   Workers, D1, KV and Zero Trust (the way decision 0007 worked). **Check in the dashboard** for the exact place.
   Accept the email. `npx wrangler whoami` must now list both the hosting account and theirs.
3. If their domain is on Cloudflare in this account, the copy can answer on it (for example
   `pipeline.clientdomain.com`). If not, it answers on `workers.dev` until the domain moves.

## 3. The client's GitHub

The repo is public, so the client **forks** it into their own account, or you put a copy of the commit from step 0 into
a new repository they own. The copy deploys by hand with wrangler (decision 0007); nothing in the repo deploys by
itself and no repo secret is needed. Give them docs/INSTALL.md and docs/UPDATING.md. Updates after handover are theirs.

## 4. Sign-in in their account

Do docs/ACCESS-SETUP.md steps 1 to 4 in **their** Zero Trust organisation, with their owner emails and the new host.
Keep the five values and the new team domain and AUD tag for step 5.

## 5. Provision the new copy

```bash
npm run copies:provision -- --copy <new>
```

At the prompt, choose **their** account. It makes their databases, KV and config in `.copies/<new>/` and sets up the
defaults (docs/INSTALL.md, step 4). Use the new team domain and AUD tag, the same owner emails, and leave the brief
"from" address empty until step 7. Then deploy: `npm run copies:update -- --copy <new>`.

## 6. Move the data

**Gap:** there is no one-command restore of a whole copy yet. `copies:export` writes a full export, but the importers
read only people, deals and tasks (decisions 0034 to 0037). Decide before the first real handover which way to go:

- **People, deals and tasks** come across with the board's CSV import (docs/INSTALL.md, step 8), which accepts the
  export's own files and keeps ids. Settings, stages, fields, rules, the rulebook, saved views, time entries and
  campaigns do not; set them up again with the AI app, or copy them by hand from the export.
- **The whole database, change log included**, may be possible with wrangler's own D1 export and import commands. They
  have not been tried on this schema. Check Cloudflare's D1 documentation first and rehearse it.

Either way the suppression list must come across: nobody who unsubscribed may be emailed again. Check that
`email_suppressions` rows exist in the new copy before any campaign sends.

## 7. Move the secrets and email

No secret can be read back from Cloudflare, so each one is made again, in their account, by the person who owns it.
Never ask for a key in chat or email. Have them paste it at the `wrangler secret put` prompt (docs/SECRETS.md has every
name), on a call if needed.

| What | What happens |
|---|---|
| `ACCESS_*` (five) | From their new Access application (step 4) |
| `INTAKE_SECRET` | A new random value; their website's form handler is updated to send it |
| Resend (`RESEND_API_KEY`, `CAMPAIGN_RESEND_API_KEY`, `CAMPAIGN_WEBHOOK_SECRET`) | Their own Resend account: add the same sending subdomain, replace the DNS records it shows, new keys limited to that domain, a new webhook at the new host (docs/CAMPAIGNS.md). Then remove the domain from your Resend account. Check Resend about a domain that sits in two accounts. |
| `VAPID_*` | New keys; every device turns notifications on again |
| `EMAIL_LOG_ADDRESS` | A new log address on their domain (docs/EMAIL-LOGGING.md); the owner changes their Bcc |

Set `BRIEF_FROM` and `CAMPAIGN_FROM` in `.copies/<new>/wrangler.jsonc` after Resend verifies.

## 8. Check it

1. docs/ACCESS-SETUP.md step 7: the board opens for an owner email only, and the bypass paths answer.
2. Reconnect their AI app to the new `/mcp` address and ask "What's in my pipeline?"; add the board to their phone again.
3. The counts on the new board match the export. Take an export in their account.
4. Send a test brief and, if they use campaigns, run docs/CAMPAIGNS.md step 8's go-live check.
5. The client says in writing that it works and that they hold the export.

## 9. Remove your access and the old copy

Only after step 8's written yes. These steps delete data and cannot be undone:

1. The client removes your login from their Cloudflare **Members** and from their GitHub, and you remove their domain
   and keys from your Resend account.
2. In the hosting account, delete the old copy: its Worker, both D1 databases, both KV namespaces and its Access
   applications, and remove its owner emails from Zero Trust (this frees seats; docs/ACCESS-SETUP.md). **Open
   question:** campaign emails already sent carry unsubscribe links on the old host. Keep the old copy running with
   sending off for as long as you agree with the client, then delete it.
3. Delete `.copies/<name>/`, `.copies/<new>/` and the client's folders under `exports/` on your Mac.

## 10. Record the handover

In the master's client record (never in this repo), write: the handover date (**the date your responsibility for the
copy ends**), the commit handed over, what moved, and the client's written confirmation from step 8.
