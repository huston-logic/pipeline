# 0030: A phone notification when the daily brief is ready (web push)

Run 4, task D1, 2026-11-20. Replaces the "No service worker" bullet of 0019 for push only (0019 is otherwise
unchanged). Builds on 0011 (the daily brief), 0014 and 0017 (board writes), 0019 (home-screen app). Numbers 0023 to
0029 are left for other run 4 tasks.

## Context

The owner's run 4 brief (Part D) asked for a phone notification when the brief is composed, from the home-screen app:
a fixed "Your daily brief is ready" that opens the Brief tab, no pipeline data through a push service, a service worker
that handles push and notification clicks only and caches nothing, a subscriptions table, a "Turn on notifications"
button behind a tap, a "Send a test" button, per-copy keys made by a script, off until the keys exist, and a record
that this outbound call carries no customer data. Decision 0019 had ruled out any service worker.

Research (WebKit's web push posts, RFC 8030, 8291 and 8292): iOS and iPadOS 16.4+ deliver web push only to a web app
added to the Home Screen; permission must be asked from a tap; `userVisibleOnly: true` is required and every push must
show a notification, or the phone may revoke the subscription. Whether Apple's push service (and FCM) deliver a push
with no body was not confirmed in the docs read.

## Decision

- **One service worker, for this only.** `public/sw.js` is the only service worker, registered only by
  `public/push.js` at `/sw.js` (scope `/`). It handles two events and nothing else:
  - `push`: `showNotification("Your daily brief is ready", { body: "Open the Brief tab.", icon:
    "/icons/icon-192.png", tag: "brief" })`, the same text every time; the payload is not read.
  - `notificationclick`: close the notification, then navigate a board window this worker controls
    (`clients.matchAll({ type: "window" })`) to `/brief` and focus it, or else `clients.openWindow("/brief")`.
  It caches nothing, has no `fetch` handler, uses no `caches`, no `importScripts` and no other code; every page still
  comes from the Worker behind the sign-in. `scripts/no-service-worker.test.mjs` enforces all of this. The Worker
  serves `/sw.js` (a static file) with `Cache-Control: no-cache`, so the phone checks for a new version on each load.
- **No customer data goes out.** Each push carries the fixed payload `{"kind":"brief"}`, encrypted for that browser
  (RFC 8291, `Content-Encoding: aes128gcm`, Web Crypto only, no dependency), with `TTL: 86400` and `Urgency: normal`,
  signed with the copy's VAPID key (RFC 8292: ES256 JWT, `aud` the endpoint's origin, `exp` 12 hours, `sub` the
  `VAPID_SUBJECT` secret). No names, deal titles, counts or ids. The endpoint it is sent to comes from the owner's own
  browser (the push service that browser uses), stored in `push_subscriptions` (migration 0007); it is never shown on
  a page, in a change summary or in a log. An encrypted fixed payload rather than an empty push, because an empty push
  is not confirmed to reach every push service and the brief allows a payload "encrypted to the standard and free of
  names"; the encryption is tested against RFC 8291 Appendix A byte for byte.
- **Subscriptions are audited changes.** Turn on (`push_subscribe`), Turn off (`push_remove`, both actor owner) and
  "gone" (actor system, tool `push_send`: the push service answered 404 or 410) are each one change with a one-line
  summary naming the device as "notifications on one device (ps_…)", and each can be undone. Nothing is deleted: off
  sets `gone_at`. An endpoint that is already on with the same keys is no change; with new keys it is a key update (an
  audited change); one that was turned off comes back on as the same row. At most 20 devices are on at once; a 21st
  is refused in plain words. The endpoint must be https, at most 1,000 characters, with no user name or password; the
  keys must be a 65-byte P-256 point and a 16-byte secret.
- **Where the endpoint and keys live.** In `push_subscriptions`, and, like every change, in the `before`/`after`
  snapshots of `audit_log`. So they reach the owner's own export through `audit_log` (the `push_subscriptions` table
  itself is not exported: delivery addresses for the owner's devices, not pipeline data). They are never shown on the
  board, in a change summary, in a log or through MCP (no MCP tool reads that table, and summaries name a device by its
  `ps_` id). The board's device rows carry only the endpoint's SHA-256, so push.js can recognise its own row.
- **At brief time.** After `runBrief` stores the day's brief (only the run that stored it), it emails the brief and
  records the email's status first, then sends one push to every subscription that is on, all at once
  (`Promise.allSettled`), each with a 10-second timeout and `redirect: "manual"` (a 3xx counts as failed). A slow or
  silent push service can't hold back the email or leave the brief "pending". A push failure never stops the brief;
  the cron log gets counts only (`pushed`, `push_gone`, `push_failed`, present only when the copy has push keys).
- **The board.** "Notifications" under More (`/notifications`): "Turn on notifications" (push.js, on the tap: ask for
  permission, register `/sw.js`, subscribe with the copy's public key, fill the form's hidden fields and send it as a
  normal page load), the devices that are on with "Turn off" each, and "Send a test" (counts only, shown on the page).
  On load, when this browser's own subscription (`pushManager.getSubscription()`) is one of the listed rows, push.js
  marks that row "This phone" and shows "Turn off on this phone" instead of Turn on (POST `/notifications/off` with the
  browser's endpoint; the same audited remove). Without JavaScript the per-device Turn off buttons are the way.
  The POST routes are in the board route table (sign-in, same origin, form body, CSRF, then the service). Without
  JavaScript or without push in this browser, the page says in one line that this browser can't turn notifications
  on (on an iPhone, add the board to the Home Screen first). `push.js` loads only on this page.
- **Keys and off switch.** `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` and `VAPID_SUBJECT` are per-copy secrets
  (docs/SECRETS.md), made by `node scripts/make-vapid-keys.mjs --copy <name> --subject mailto:<owner email>` (the
  subject is required), which prints the three `wrangler secret put` commands with the values and writes no file.
  `npm run dev` and `npm run preview` make a throwaway pair in memory on each start (passed as `--var`, never written
  to a file), so local accessibility, Lighthouse and screenshot runs see the page with keys. Until all three are set and well formed, the page says "This copy
  has no notification keys yet." with nothing to tap, and the brief sends no push. The public key reaches the page as a
  data attribute (it is public by design); the private key never leaves the Worker.
- **CSP unchanged.** `sw.js` and `push.js` are first-party files from `public/` (`script-src 'self'`); the Worker, not
  the page, talks to the push service, so `connect-src` stays `'self'`.

## Why

- The owner asked for it, and a fixed notification is the smallest thing that does the job: the phone learns only that
  a brief exists, and the owner opens the board (behind Access) to read it.
- A service worker that caches nothing keeps 0019's reason intact: no private data at rest on the phone and nothing
  stale after a sign-out.
- Web Crypto covers ECDH, HKDF, AES-GCM and ECDSA in both Workers and Node, so no dependency is needed.

## Consequences

- **The Access caveat.** The browser fetches `/sw.js` when registering and on its update checks, behind Cloudflare
  Access like every board path. With an expired Access session the update check fails and the phone keeps the service
  worker it has, which is harmless (it only shows the fixed notification). Push delivery itself does not involve
  Access: the Worker sends to the push service, and the push service wakes the service worker.
- On an iPhone, notifications work only from the Home Screen app (iOS 16.4+), and only after a tap on "Turn on
  notifications" there.
- Each copy's owner must make and set the three secrets (a STOP item for the repo owner). Making a new key pair later
  stops notifications to the devices subscribed with the old one until each turns them off and on again.
- The Worker POSTs to whatever https endpoint the owner's signed-in browser gave it. Only the owner can add one (board
  sign-in, same origin and CSRF), so this is accepted rather than limiting endpoints to a list of known push hosts that
  could change.
- A later change that wants more in the notification (a count, a name) needs a new decision: it would put pipeline data
  through a third-party push service.
