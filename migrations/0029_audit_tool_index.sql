-- 0029: an index on the audit log by tool and time (run 12). Every signed-in page reads the newest timer change
-- (start_timer, stop_timer, cancel_timer), which scanned the whole log. Adds an index only; no row changes.

CREATE INDEX IF NOT EXISTS audit_log_tool_at ON audit_log (tool, at);
