-- Email logging by BCC (decision 0031): one row per accepted message, keyed by its Message-ID (or, without one, a
-- sha256 of its Date, From and Subject), so the same message is never logged twice. A system log like `briefs`, not
-- owner data: no audit row, not undoable. `matched` is how many people the message was logged for (0 to 5) and
-- `unmatched` how many of its other To and Cc addresses matched no one; the daily brief counts rows with matched = 0.
-- `local_date` is the owner's date when it arrived.

CREATE TABLE email_log (
  message_key TEXT PRIMARY KEY,
  received_at TEXT NOT NULL,
  local_date TEXT NOT NULL,
  matched INTEGER NOT NULL CHECK (matched >= 0),
  unmatched INTEGER NOT NULL CHECK (unmatched >= 0)
) STRICT;

CREATE INDEX email_log_received ON email_log (received_at);
