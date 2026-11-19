-- 0005: activities by time. preview_rule reads the activities of a recent window across every deal and contact
-- (`occurred_at >= ?`, no deal or contact), which the (deal_id, occurred_at) and (contact_id, occurred_at) indexes
-- cannot serve, so it scanned the whole table (decision 0010; run 2 R7, docs/PAID-PLAN.md). An index only: no data
-- changes.

CREATE INDEX activities_occurred ON activities (occurred_at);
