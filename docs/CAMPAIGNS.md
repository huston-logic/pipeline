# Campaign emails: setup (per copy)

This is for the owner of one copy of the pipeline, in the client's own accounts. It turns on sending campaign emails
from the board (decision 0053). Every step is separate. Nothing sends until all the steps are done and you tap Approve
on the board.

Throughout, `<copy>` is the copy's name (its folder name in `.copies/`), and `<copy host>` is the address the copy
answers on, as in docs/ACCESS-SETUP.md. `example.com` stands for your own domain.

Steps marked **(check in the dashboard)** were not confirmed when this was written (2026-11-24). Follow what the
dashboard shows and note any difference.

## What stays off until you finish

- **Campaigns** is a setting, off by default. While it is off, the board has no Campaigns page and the AI app cannot
  make campaigns. To turn it on, tell your AI app "turn on campaigns". It runs `update_settings` with `campaigns` set
  to true.
- **Sending** needs a postal address, the switch in step 4, a from address, and a Resend key (steps 1 to 4). The
  Campaigns page names the first missing piece in plain words.
- Even when everything is set, no email goes out until you open a campaign on the board and tap **Approve and send**
  (or **Schedule**).
- The AI app can only draft. It cannot send, schedule or approve.

## Before you start

- The copy runs code that has campaigns. Run `npm run copies:update -- --copy <copy>` first (docs/UPDATING.md).
- The domain you send from is on Cloudflare, in the same account as the copy's Worker.
- You can open a terminal in the repo folder. Commands below run there, with your own wrangler login.

## 1. A Resend account in the client's name

Resend is the service that sends the email. Use an account in the client's own name, not yours.

1. Go to resend.com and select **Sign up**. Use the client's own email address.
2. Check the plan limits at resend.com/pricing, because they can change. As of 2026-11-24: the Free plan allows 100
   emails a day and 3,000 a month. Pro costs $20 a month and allows 50,000 a month with no daily limit.
3. Keep the campaign daily limit (step 5) under the plan's daily limit. The daily brief also uses Resend.

## 2. A sending subdomain

Use a subdomain, such as `news.example.com`. Complaints and bounces from campaigns then hit the subdomain's
reputation, not your main mailbox.

1. In Resend, open **Domains** and select **Add domain**.
2. Enter the subdomain, `news.<your domain>`, and select **Add**.
3. Resend shows DNS records: an SPF TXT record, a DKIM TXT record, and an MX or TXT record for the return path. Copy
   each one exactly, the name and the value.
4. In Cloudflare, open your domain, then **DNS** > **Records**. Add each record exactly as Resend shows it.
5. Set each record to **DNS only** (grey cloud). Do not use **Proxied** (orange cloud).
6. Back in Resend, select **Verify** on the domain. It can take from 15 minutes to 72 hours. Come back later if it
   fails.
7. If your domain has no DMARC record, add one. Resend's DMARC page in its docs explains the record. **(check in the
   dashboard)**

## 3. An API key that can only send from the subdomain

A DNS record is public, so this key is a secret. Never paste it into chat, a document or a file.

1. In Resend, open **API Keys** and select **Create API key**.
2. Name it, for example `pipeline campaigns`.
3. Set **Permission** to **Sending access**, and **Domain** to the subdomain from step 2 (not all domains).
4. Create the key. Copy it now. Resend shows it once.
5. In the terminal, run:

   ```bash
   npx wrangler secret put CAMPAIGN_RESEND_API_KEY -c .copies/<copy>/wrangler.jsonc
   ```

   `wrangler secret put` stores a secret in the Worker. `-c` picks this copy's config. Paste the key when asked.

This key is separate from the brief's `RESEND_API_KEY`. Keep both.

## 4. The from address and the sending switch

These two are plain settings, not secrets. They go in the copy's own config.

1. Open `.copies/<copy>/wrangler.jsonc` in a text editor. Find the `vars` block where `BRIEF_FROM` is.
2. Add these two lines inside `vars`, keeping the commas right:

   ```jsonc
   "CAMPAIGN_SENDING": "on",
   "CAMPAIGN_FROM": "Acme Studio <news@news.example.com>",
   ```

   The address must be on the subdomain from step 2. The name in front is optional.
3. Save the file. Then run:

   ```bash
   npm run copies:update -- --copy <copy>
   ```

   This writes the config to the Worker. Leave `CAMPAIGN_SENDING` unset to keep sending off.

## 5. The postal address and the daily limit

1. On the board, open **More** > **Campaigns**, then **Campaign settings**.
2. **Postal address:** your business's postal address. Every campaign email shows it in the footer. Line breaks are kept.
3. **Daily limit:** the default is 90. The limit counts UTC days (the day starts at midnight UTC, not your local
   midnight). The daily brief is not counted in this limit, so leave room for it. 90 leaves room for the brief on
   Resend Free.
4. Select **Save**.

## 6. Let the public paths through Access (Bypass)

Two paths must reach the Worker without the board's sign-in. People click the unsubscribe page from an email. Resend
calls the webhook. Each page checks its own token or signature, so no sign-in is needed.

1. In the Cloudflare dashboard, open **Zero Trust** > **Access controls** > **Applications**.
2. Open the **Pipeline bypass** application from docs/ACCESS-SETUP.md, step 3. Its rows are where the bypass paths
   live. Do not change the board's own application.
3. Select **Edit**. Select **Add public hostname** and choose `<copy host>`. In **Path**, enter `unsubscribe`. This
   covers `/unsubscribe/*` and `/unsubscribe/board.css`.
4. Add one more row: the same host, path `hooks/resend`.
5. Save. The policy is already **Bypass** for **Everyone**, so nothing else changes.
6. Check it. Open a private window and go to `https://<copy host>/unsubscribe/test`. It must show
   "This link is from a test email." with no sign-in page.

## 7. Delivery results from Resend (optional)

The webhook tells the board when an email was delivered, bounced, marked as spam, or failed. Without it, sent emails
stay "Sent". Everything else still works.

Do steps 1 to 5 in one sitting, before any campaign is sent. Until the secret is set the Worker answers 503, so
Resend retries each event (for about 37 hours) and would disable the endpoint if that went on.

1. In Resend, open **Webhooks** and select **Add endpoint**.
2. Endpoint URL: `https://<copy host>/hooks/resend`.
3. Select these events: `email.delivered`, `email.bounced`, `email.complained`, `email.suppressed`, `email.failed`.
4. Save the endpoint, then open it and copy its **signing secret** (it starts with `whsec_`). Keep it in a password
   manager.
5. Straight away, in the terminal, run:

   ```bash
   npx wrangler secret put CAMPAIGN_WEBHOOK_SECRET -c .copies/<copy>/wrangler.jsonc
   ```

   Paste the `whsec_` value when asked.

## 8. Go-live check

Do this once, after steps 1 to 7. It uses your own email address.

1. Make sure you are a person on the board with your own email address. If not, add yourself on **People**.
2. On the board, open **More** > **Campaigns** > **New campaign**. Enter a name, a subject and a short body. Under
   **Who gets it**, choose **People I pick** and pick your own person. Select **Save**.
3. Open the campaign and select **Send test to me**. The email arrives in your inbox, with a subject that starts with
   "Test: ".
4. Check the footer of the test: the business name, the postal address and an **Unsubscribe** link.
5. Select **Unsubscribe** in the test. The page says nothing changed, because test links never change anything.
6. Make a new campaign with the same person, and select **Approve and send**. It goes out within 15 minutes. Check
   your inbox.
7. In that real email, select **Unsubscribe**. The page says you're unsubscribed.
8. Open your person page on the board. It shows the unsubscribe with its date. To allow emails again, select
   **Allow campaign emails again** and confirm. Do that now if you want to keep receiving them.

## How sending works

- Every 15 minutes, at 5, 20, 35 and 50 minutes past the hour (UTC), the Worker sends the next batch of up to 100 emails.
- The daily limit counts UTC days. Test emails count toward it. The limit is set in step 5.
- The list of people is fixed when you approve. Someone added later is not in that campaign.
- A person who unsubscribes or bounces after approval is skipped at the next batch. They are not sent the email.
- "Not confirmed" means Resend may or may not have sent that batch. The batch is never sent again, so nobody gets an
  email twice.
- If you change the business name, postal address or accent while a batch is being retried, that batch is marked Not
  confirmed instead of being sent again.
- **Pause** stops new batches. A batch already handed to Resend still finishes. **Cancel** does the same and stops the
  emails still waiting. Undo does not work on sending steps.

## Rules that protect you

- Every email has a one-click unsubscribe link and the List-Unsubscribe headers, so mail apps can show their own
  unsubscribe button.
- An unsubscribe, a bounce or a spam complaint means that address is never sent a campaign again.
- Only you can allow an unsubscribe again, on the person's page, with a confirm. The AI app cannot.
- The AI app can only draft campaigns. It cannot send, schedule, approve, pause, cancel or clear an unsubscribe.
- A campaign email does not count as contact with the person. It does not stop follow-up reminders for them.
- Test emails go only to you, and at most 10 a UTC day.

## If something is wrong

- **The Campaigns page names a missing piece.** Set that piece (steps 1 to 4), then run `npm run copies:update -- --copy <copy>`
  again.
- **"Resend refused the last batch."** Nothing in that batch was sent. Check step 2 (the domain is verified) and step 3
  (the key can send from the subdomain). Then select **Resume** on the campaign.
- **Delivered or bounced never shows.** Check step 7: the endpoint URL, the five events and the secret.
