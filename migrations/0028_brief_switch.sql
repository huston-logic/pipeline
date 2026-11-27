-- 0028: the daily brief becomes a switch (run 12). Off for every copy, existing ones included, until the owner turns it
-- on (settings.brief). Off means no Brief page, no composing, no email and no phone notification; the follow-up rules
-- run either way. Adds one settings column with a default; every stored brief and every other row keeps its values.

ALTER TABLE settings ADD COLUMN brief INTEGER NOT NULL DEFAULT 0 CHECK (brief IN (0, 1));
