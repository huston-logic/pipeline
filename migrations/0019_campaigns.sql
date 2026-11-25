-- 0019: campaigns, step 1 (docs/superpowers/specs/2026-11-24-campaigns-design.md). Three settings columns and five
-- tables: campaigns, their steps, the frozen recipient list, the sending batches and the address suppressions.
-- Campaigns are off until settings.campaigns is 1. Every existing row keeps its values.
-- campaigns, campaign_steps and email_suppressions are change tables (audited, undoable apart from sending steps);
-- campaign_recipients and campaign_batches are delivery records written next to an audited change, never undone.

ALTER TABLE settings ADD COLUMN campaigns INTEGER NOT NULL DEFAULT 0 CHECK (campaigns IN (0, 1));
-- Printed in every campaign email; NULL until the owner adds it.
ALTER TABLE settings ADD COLUMN postal_address TEXT CHECK (postal_address IS NULL OR length(postal_address) BETWEEN 1 AND 300);
ALTER TABLE settings ADD COLUMN campaign_daily_limit INTEGER NOT NULL DEFAULT 90 CHECK (campaign_daily_limit BETWEEN 1 AND 5000);

CREATE TABLE campaigns (
  -- "cp_" and 12 base32 characters.
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'scheduled', 'sending', 'paused', 'sent', 'cancelled')),
  -- {"kind":"status","status":"<key>"}, {"kind":"view","view":"vw_..."} or {"kind":"people","people":["ct_...", ...]}.
  audience TEXT NOT NULL CHECK (json_valid(audience) AND json_type(audience) = 'object'),
  first_name_fallback TEXT NOT NULL DEFAULT 'there' CHECK (length(first_name_fallback) BETWEEN 1 AND 40),
  -- The AI's suggestion; never acted on.
  suggested_send_at TEXT,
  -- Set when approved or scheduled.
  send_after TEXT,
  approved_at TEXT,
  -- The board's origin at approval, for the links in the emails.
  base_url TEXT,
  -- A fixed phrase, or NULL.
  send_error TEXT,
  completed_at TEXT,
  archived INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0, 1)),
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
) STRICT;

CREATE INDEX campaigns_status ON campaigns (status) WHERE archived = 0;

CREATE TABLE campaign_steps (
  -- "cs_" and 12 base32 characters.
  id TEXT PRIMARY KEY,
  campaign_id TEXT NOT NULL REFERENCES campaigns (id),
  -- 1 in step 1.
  position INTEGER NOT NULL CHECK (position >= 1),
  subject TEXT NOT NULL CHECK (length(subject) BETWEEN 1 AND 150),
  body TEXT NOT NULL CHECK (length(body) BETWEEN 1 AND 20000),
  -- Both or neither; the address is https only.
  button_label TEXT CHECK (button_label IS NULL OR length(button_label) BETWEEN 1 AND 40),
  button_url TEXT CHECK (button_url IS NULL OR (length(button_url) <= 2000 AND button_url LIKE 'https://%')),
  -- Room for series; null in step 1 and not read by anything yet.
  delay_days INTEGER CHECK (delay_days IS NULL OR delay_days >= 0),
  stop_when TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CHECK ((button_label IS NULL) = (button_url IS NULL))
) STRICT;

CREATE UNIQUE INDEX campaign_steps_position ON campaign_steps (campaign_id, position);

-- One sending attempt: a batch of emails, or a test send (count 1). Its id is the Resend Idempotency-Key.
CREATE TABLE campaign_batches (
  -- "cb_" and 12 base32 characters.
  id TEXT PRIMARY KEY,
  campaign_id TEXT NOT NULL REFERENCES campaigns (id),
  kind TEXT NOT NULL CHECK (kind IN ('send', 'test')),
  status TEXT NOT NULL DEFAULT 'in_flight' CHECK (status IN ('in_flight', 'done', 'returned', 'uncertain')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  attempts INTEGER NOT NULL DEFAULT 1,
  -- An HTTP status or a fixed phrase.
  last_status TEXT
) STRICT;

CREATE INDEX campaign_batches_campaign ON campaign_batches (campaign_id, created_at);

-- The frozen list: one row per person per step.
CREATE TABLE campaign_recipients (
  -- "rc_" and 12 base32 characters.
  id TEXT PRIMARY KEY,
  campaign_id TEXT NOT NULL REFERENCES campaigns (id),
  step_id TEXT NOT NULL REFERENCES campaign_steps (id),
  contact_id TEXT NOT NULL REFERENCES contacts (id),
  -- Lowercased and frozen when the list was made.
  email TEXT NOT NULL CHECK (email = lower(email)),
  -- The frozen merge value, or NULL.
  first_name TEXT,
  status TEXT NOT NULL CHECK (
    status IN ('skipped', 'queued', 'sending', 'sent', 'delivered', 'bounced', 'complained', 'failed', 'uncertain', 'cancelled')
  ),
  skip_reason TEXT CHECK (
    skip_reason IS NULL OR skip_reason IN ('no_email', 'bad_email', 'unsubscribed', 'bounced', 'complained', 'archived')
  ),
  -- 32 random bytes, base64url, made at approval; never shown, logged or exported. NULL on a skipped row.
  unsub_token TEXT,
  batch_id TEXT REFERENCES campaign_batches (id),
  claimed_at TEXT,
  resend_id TEXT,
  sent_at TEXT,
  delivered_at TEXT,
  bounced_at TEXT,
  complained_at TEXT,
  unsubscribed_at TEXT,
  version INTEGER NOT NULL DEFAULT 1
) STRICT;

CREATE UNIQUE INDEX campaign_recipients_person ON campaign_recipients (campaign_id, step_id, contact_id);
CREATE UNIQUE INDEX campaign_recipients_email ON campaign_recipients (campaign_id, step_id, email) WHERE status <> 'skipped';
CREATE UNIQUE INDEX campaign_recipients_token ON campaign_recipients (unsub_token) WHERE unsub_token IS NOT NULL;
CREATE INDEX campaign_recipients_resend ON campaign_recipients (resend_id);
CREATE INDEX campaign_recipients_claim ON campaign_recipients (status, claimed_at);

-- An address campaigns never send to again (the owner may clear an unsubscribed one on the person's page).
CREATE TABLE email_suppressions (
  -- "su_" and 12 base32 characters.
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL CHECK (email = lower(email)),
  reason TEXT NOT NULL CHECK (reason IN ('unsubscribed', 'bounced', 'complained')),
  contact_id TEXT REFERENCES contacts (id),
  campaign_id TEXT REFERENCES campaigns (id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  cleared_at TEXT,
  version INTEGER NOT NULL DEFAULT 1
) STRICT;

CREATE UNIQUE INDEX email_suppressions_live ON email_suppressions (email) WHERE cleared_at IS NULL;
