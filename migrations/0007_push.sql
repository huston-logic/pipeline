-- 0007: web push subscriptions for the brief notification (decision 0030). One row per browser that turned
-- notifications on: the push service's endpoint and the browser's encryption keys (p256dh, auth), all from the owner's
-- own browser. Turning one off, or the push service saying it is gone, sets gone_at; nothing is deleted. Subscribe,
-- turn off and "gone" are audited changes, so each can be undone. Adds a table only: earlier data is untouched.

CREATE TABLE push_subscriptions (
  id TEXT PRIMARY KEY,
  endpoint TEXT NOT NULL UNIQUE CHECK (length(endpoint) <= 1000 AND substr(endpoint, 1, 8) = 'https://'),
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  gone_at TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
) STRICT;
