-- 0025: where AI changes are approved. 'chat' (the default) keeps today's behaviour: the AI app shows the owner a
-- proposal and calls apply_changes after the owner's yes. 'board': apply_changes over MCP refuses and the owner presses
-- Approve on the board. Adds one column with a default; every existing row keeps its values.

ALTER TABLE settings ADD COLUMN ai_approval TEXT NOT NULL DEFAULT 'chat' CHECK (ai_approval IN ('chat', 'board'));
