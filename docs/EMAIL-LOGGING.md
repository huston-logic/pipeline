# Email logging by BCC: setup

Once this is set up, an email you send to a lead or contact shows up on their timeline when you add the copy's log
address in Bcc (decision 0031). Only mail you send from one of the copy's owner emails, that passes Cloudflare's
authentication checks, is logged; everything else sent to the address is dropped without an answer.

This is done once per copy, by the owner, in the client's Cloudflare account. It touches DNS, so it is a STOP item:
nothing in this repo does it for you. `example.com` below stands for the copy's own domain.

Steps marked **(check in the dashboard)** were not confirmed in Cloudflare's docs when this was written
(2026-11-20); follow what the dashboard shows and note any difference here.

## Before you start

- The copy runs the code with email logging: run `npm run copies:update` first (docs/UPDATING.md).
- The domain is on Cloudflare, in the same account as the copy's Worker.
- Your sending address is one of the copy's owner emails (the ones that can sign in to the board).
- Your sending address's domain has a DMARC record (a TXT record at `_dmarc.<your domain>`). Mail whose domain has
  none gets `dmarc=none` from Cloudflare and is dropped by design (decision 0031, Ruling 3). A strict policy,
  `p=quarantine` or `p=reject` (for example `v=DMARC1; p=reject`), is recommended: Email Routing then rejects mail that
  fails your domain's DMARC before the Worker runs, so a forged email "from you" never reaches it at all (decision
  0031, Consequences). Check your domain's DNS before you start.

## 1. Pick a subdomain

Use a subdomain only, such as `log.example.com`, so the mail records of `example.com` itself (your own inbox) are never
touched. Email Routing adds MX records to the domain it is set up on, and MX records on `example.com` would take over
your own mail.

## 2. Turn on Email Routing for the subdomain

1. In the Cloudflare dashboard, open **Compute > Email Service > Email Routing**.
2. Choose **Onboard Domain** and pick the subdomain `log.example.com`. **(check in the dashboard)** whether a subdomain
   can be onboarded on its own; if the dashboard only offers `example.com`, stop and do not onboard the main domain.
3. Add the DNS records the dashboard lists, on the subdomain. At the time of writing they were:
   - MX records for the subdomain pointing to `route1.mx.cloudflare.net`, `route2.mx.cloudflare.net` and
     `route3.mx.cloudflare.net`, with the priorities the dashboard shows;
   - a TXT record for the subdomain: `v=spf1 include:_spf.mx.cloudflare.net ~all`;
   - the DKIM TXT record `cf2024-1._domainkey` (under the subdomain) with the value the dashboard shows.
   **(check in the dashboard)** the exact names: for a subdomain they should end in `.log.example.com`, never sit on
   `example.com` itself.

## 3. Make the address

Run this on your own computer to get 32 random hex characters:

```bash
openssl rand -hex 16
```

The log address is `log-` followed by those characters, at the subdomain, for example
`log-<the 32 characters>@log.example.com`. The random part keeps strangers from guessing it. Keep it out of chat,
issues and pull requests.

## 4. Set the secret

From the repo folder, with your own wrangler login:

```bash
npx wrangler secret put EMAIL_LOG_ADDRESS -c .copies/<copy>/wrangler.jsonc
```

Paste the full address when asked. Until this is set, the copy drops every email and the board's Email logging page
says "Email logging isn't set up for this copy."

## 5. Route the address to the Worker

1. In **Email Routing**, open **Routing Rules** and choose **Create routing rule**.
2. Custom address: the log address from step 3.
3. Action: **Send to a Worker**. Destination: the copy's Worker.
4. Save. Leave the catch-all off (or dropping): the Worker only logs mail to this one address anyway.

## 6. Go-live check (both parts, before relying on it)

Do this once, right after setup. The Worker trusts the first `Authentication-Results` header it is handed, which
Cloudflare's docs say is Cloudflare's own (decision 0031 explains the one assumption this rests on). Part (b) checks
that Cloudflare really did run its checks on your mail.

Keep the Worker's log open while you test:

```bash
npx wrangler tail -c .copies/<copy>/wrangler.jsonc
```

**(a) A normal email is logged.**

1. On the board, open **More > Email logging** and check the address is the one you made.
2. Send an email from your own address to a test contact who is on the board (their email must be on their contact
   record), with the log address in Bcc.
3. Open that contact. The timeline shows an email "Logged by BCC", with the subject and body labelled From outside. A
   New lead becomes Contacted.

**(b) Cloudflare checked the test email.**

1. In the Cloudflare dashboard, open the log subdomain's **Email Routing** and its activity log, and open the test
   email from (a). **(check in the dashboard)** the exact place: the click path for the activity log and its message
   details was not confirmed in Cloudflare's docs when this was written.
2. It must show Cloudflare's SPF, DKIM and DMARC results for the email, with **DMARC: pass**.

**If (b) shows no DMARC pass from Cloudflare** (or no SPF/DKIM/DMARC results at all) while (a) logged the email, the
Worker did not get its verdict from Cloudflare as expected, and a forged one could get through. Turn email logging off
at once by removing the secret (the Worker then drops every email):

```bash
npx wrangler secret delete EMAIL_LOG_ADDRESS -c .copies/<copy>/wrangler.jsonc
```

Leave it off until the cause is found (decision 0031, Consequences).

If (a) shows nothing within a few minutes, look in the log for the drop reason:

`{"event":"email_log_dropped","reason":"…"}`:

- `not_set_up`: the secret from step 4 is missing.
- `wrong_address`: the routing rule sends a different address than the secret holds.
- `not_owner`: the sending address (or the mail provider's envelope sender) is not an owner email.
- `not_authenticated`: Cloudflare's authentication result did not pass, or the Worker could not find it. First check
  your sending domain has a DMARC record (see Before you start). If every email from a normal mailbox still gets
  this, Cloudflare's header may not reach the Worker as expected (decision 0031, Consequences); report it before
  relying on the feature.
- `too_large`: the email was over 1 MB (attachments count); send it without the attachment.

## What gets logged

- Up to five people in To and Cc whose email matches a contact (archived contacts are skipped). You and the log
  address are never matched.
- One email activity on each person, with the subject and the first 5,000 characters of the text. Attachments are not
  kept.
- The same email (same Message-ID) is logged once, however many times it arrives.
- Replies from leads are not logged: they come to your own inbox, not to the log address.
- If an email matched no one, the next daily brief says so, for example "2 logged emails matched no one." Add the
  person as a contact, or check the address on their record.
