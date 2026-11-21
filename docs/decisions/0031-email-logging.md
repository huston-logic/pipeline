# 0031: Email logging by BCC

Run 4, task C1, 2026-11-20. Builds on 0009 (changes and undo), 0011 (the daily brief), 0012 (outside text at
`/intake`), 0013 and 0021 (outside text on the board, the Copy button) and 0022 (leads on contacts).

## Context

The owner wants an email they send to a lead or contact to show up on that person's timeline without typing it in:
they add a log address in Bcc. The run 4 brief (Part C) asks for an `email()` handler behind Cloudflare Email Routing on
a subdomain, accepting only mail the owner sent and that passed Cloudflare's authentication, matching To and Cc people
by email, deduping on Message-ID and counting unmatched mail for the brief. It leaves open how the authentication
result is read, what "drop" means, the caps, the dedupe key without a Message-ID, which window the brief counts, and
where the board shows the address.

## What was followed from the docs

Read on 2026-11-20 (notes in `.superpowers/sdd/2026-11-20-run4-leads/research-email-push.md`):

- Cloudflare's Email Workers docs (now under "Email Service"): `email(message, env, ctx)` on the default export;
  `message.from` and `message.to` are the envelope (MAIL FROM and RCPT TO), `message.raw` is the whole message as a
  stream and `message.rawSize` its size. `setReject` answers the sending server with a permanent SMTP error.
- "Email Routing validates DMARC before invoking your Worker. It prepends a standard `Authentication-Results`
  header", and only the first one with authserv-id `mx.cloudflare.net` is Cloudflare's; others may come from the sender.
- Inbound messages are limited to 25 MiB; the handler runs under the normal Worker CPU limits.
- Cloudflare suggests `postal-mime` to parse the MIME structure.
- Local testing: `wrangler dev` accepts a raw message posted to `/cdn-cgi/local/email?from=…&to=…`.

## Decision

- **Interface.** `handleLogEmail(message, env, now): Promise<"logged" | "duplicate" | "dropped">` in
  `src/email/log.ts`, called from `email()` in `src/index.ts` through a dynamic `import()`, so the board and its tests
  never load the parser. It takes only `from`, `to`, `headers`, `raw` and `rawSize` from the message, so it cannot
  reject, reply or forward. "logged" means the message was recorded, with one to five people or with none (then only its
  `email_log` row).
- **What is accepted.** All of these, in this order; anything else is dropped:
  1. the secret `EMAIL_LOG_ADDRESS` is set (the full address, with an unguessable local part such as
     `log-<32 random hex>@log.<domain>`);
  2. `rawSize` is at most 1 MB (the stream is also cut off at 1 MB, whatever `rawSize` said);
  3. the envelope `to` equals `EMAIL_LOG_ADDRESS`, ignoring case;
  4. the envelope `from` is an owner email (the same list the board sign-in uses: `settings.owner_emails` plus
     `OWNER_EMAILS`, ignoring case);
  5. **Ruling 3**, read from `message.headers` (the Headers object Email Routing builds and prepends its header to),
     never from the raw text, where any `Authentication-Results` header may be one the sender wrote:
     `message.headers.get("authentication-results")` must exist and start with the authserv-id `mx.cloudflare.net`
     (exactly), and say `dmarc=pass`, or, when it has no dmarc result, both `spf=pass` and `dkim=pass`. Headers joins
     several such headers into one value with ", ", so a header the sender wrote can follow Cloudflare's in that value.
     So every `spf`, `dkim` and `dmarc` result in the whole value must be a pass: a later, forged result can neither
     outvote a fail nor add a `dmarc=pass` that Cloudflare did not give. This is stricter than Ruling 3 alone (a
     `dmarc=pass` with an `spf` fail is dropped); owner mail sent directly from their own domain passes all three.
     Comments and quoted strings are skipped when reading it. It is checked before the message is read;
  6. the header From (from the parsed raw text) is an owner email too. This is one check more than the brief names: DMARC authenticates the
     header From's domain, so this is the address the pass is about.
- **Drop silently.** A dropped message is not answered at all: no `setReject` (which would tell the sender the address
  exists), no reply, no forward. The Worker writes one log line, `{"event":"email_log_dropped","reason":"…"}`, with a
  fixed reason (`not_set_up`, `too_large`, `wrong_address`, `not_owner`, `unreadable`, `not_authenticated`) and none of
  the message. An unexpected failure is logged as `{"event":"email_log_failed"}` and the message is dropped too.
- **People.** The header To and then Cc addresses (groups unwrapped, lower-cased, each once), without the log address
  and the owner emails, at most the first 100, are matched to contacts by email (the unique `lower(email)` index).
  Archived contacts are not matched. The first five matches in that order are logged; the rest are ignored.
- **One change.** One audited change per message, actor `system`, tool `email_log`, holding for each person one
  `email` activity on the person (no deal) with the fixed summary "Logged by BCC" and `untrusted_text` set to
  `Subject: <subject>`, a blank line and the body. The quiet clock and the New to Contacted move go through
  `activityEffects` in `src/services/activities.ts`, the same code `log_activity` uses for an activity with only a
  contact: every open deal of the person whose `last_activity_at` is older moves to the email's time. The change
  summary names people only through `contactName` (an outside name becomes "contact ct_…"), for example "Logged an email
  by BCC with Pat Example and Robin Sample; Pat Example is now Contacted". Undo works on it like on any change. Undoing
  it removes the activities and puts the deals and lead status back, but keeps the message's `email_log` row (that
  table is not part of the change), so the same message stays a duplicate and is never logged again.
- **Caps and cleaning.** Subject: one line, control characters dropped, at most 300 characters. Body: the text part,
  or when there is none the HTML read as text (postal-mime does this; a crude tag strip is the fallback). Only the
  first 20,000 characters (four times the cap) are cleaned, so no pattern runs long on a 1 MB body of unclosed tags.
  CRLF made LF, tabs made spaces, other control characters dropped, runs of blank lines cut to one, at most 5,000
  characters.
  Attachments are ignored, and a whole forwarded message attached to the email is one of them. The activity's time is
  the Date header when it is a real time not after now, otherwise now.
- **Dedupe.** Table `email_log` (migration 0008): `message_key` (primary key), `received_at`, `local_date`, `matched`,
  `unmatched`. A system log like `briefs`: not audited, not undoable, included in the export. The key is the
  Message-ID, trimmed, angle brackets kept as given, at most 300 characters; without one it is `sha256:` and the hex
  SHA-256 of the raw Date, From and Subject header values. A message that matches people inserts its row in the same D1
  batch as its change, so a second delivery that stored it first fails the whole batch and the answer is "duplicate";
  a message that matches no one inserts its row alone (`ON CONFLICT DO NOTHING`). A person or deal that changed between
  the read and the write is read again once, as at `/intake`.
- **The brief.** A section "Logged email", last, with one plain line when any accepted message since the previous
  brief matched no one: "2 logged emails matched no one." (rows with `matched = 0`, including mail whose only
  recipients were the owner). "Since the previous brief" is by `received_at`, the same window as new leads (after the
  previous brief's `composed_at`, or the last 24 hours before the first brief), rather than by `local_date`, so mail
  that arrives after the brief on the same day is counted the next day instead of never. The line is a count only, so
  it never carries outside text. It sits last because it is a note about the log, not something to act on first.
- **The board.** A page "Email logging" under More (`/email-log`) shows the address in a read-only field with the Copy
  button from `board.js` (the same `data-copy` behaviour as Ask Claude's prompts), and two lines: "To log an email, add
  this address in Bcc when you write to a lead or contact." and "Only mail you send from your own address is logged;
  replies from others are not." Without the secret it says "Email logging isn't set up for this copy." The address is
  shown only behind the board sign-in, never in a link, the title or the description.
- **Forwarded replies (stretch goal): not built.** A reply from a lead lands in the owner's inbox, not at the log
  address. Logging one by forwarding it would mean reading a sender out of a forwarded body, which the brief allows only
  on an exact match and which the authentication check cannot vouch for. Mail from anyone but the owner is dropped.
- **Dependency.** `postal-mime` 4.2.1, exact (MIT-0, no dependencies, published 2026-11-10), as Cloudflare suggests.
  `agents` already ships an older copy (2.7.6) for its own use.

## Why

- Email Routing is the only inbound mail Cloudflare offers a Worker, and its own header is the only authentication
  the Worker can trust; the docs say Email Routing prepends it before invoking the Worker, so it is first in
  `message.headers`. A check on the raw text alone would trust a forged header whenever Cloudflare's is not in it.
- Checking the envelope sender before reading the message means mail from strangers is dropped without being parsed.
- Silence gives an attacker nothing: no bounce tells them the address exists or what was wrong.
- Logging on the person, not a deal, is what `log_activity` does with only a contact, and it keeps the quiet clock
  and lead status rules in one place.
- Five people and 5,000 characters keep one message's change small and the timeline readable.

## Consequences

- **STOP for the owner (not confirmed in the docs read, check in the dashboard):** whether a subdomain such as
  `log.<domain>` can be its own Email Routing domain, so the owner's own mail records are untouched; the DNS records
  and routing rule for it; and setting `EMAIL_LOG_ADDRESS`. docs/EMAIL-LOGGING.md has the steps.
- Not confirmed in a live copy yet: that `message.headers` carries Cloudflare's header first, as the docs say. If it
  does not, every message is dropped as `not_authenticated` (nothing is logged, nothing forged gets through); the
  owner's first test email shows it (docs/EMAIL-LOGGING.md, step 6).
- The owner's sending domain needs a DMARC record. Without one the verdict is `dmarc=none`, which is not a pass, so
  the mail is dropped by design (Ruling 3).
- The owner's mail provider must set the envelope sender to the owner's own address. A provider that uses a bounce
  address (some newsletter tools) is dropped as `not_owner`.
- Mail sent from an alias that is not an owner email is dropped; adding it to the owner emails lets it through.
- Mail in a thread the owner sends again (same Message-ID) is logged once.
