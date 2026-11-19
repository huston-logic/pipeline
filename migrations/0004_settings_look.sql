-- 0004: the board's look, set by the owner (decision 0015). Both start empty, so the board shows "Pipeline" and the
-- default accent until the owner sets them. The service trims the name and stores the colour in lower case; the
-- checks here are the last line of defence for anything that writes SQL directly (an import, a hand fix).

ALTER TABLE settings ADD COLUMN business_name TEXT
  CHECK (business_name IS NULL OR length(business_name) BETWEEN 1 AND 60);

ALTER TABLE settings ADD COLUMN accent_color TEXT
  CHECK (accent_color IS NULL OR (length(accent_color) = 7 AND accent_color GLOB '#[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]'));
