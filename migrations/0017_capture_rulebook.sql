-- 0017: a starter "capture" rulebook document (decision 0048): how to turn a ramble into one propose_changes call.
-- INSERT OR IGNORE, so a copy that already has a capture document, or whose owner edited any other document, keeps
-- every word. seed/defaults.sql has the same text for new copies (a test checks).

INSERT OR IGNORE INTO rulebook (name, markdown) VALUES
  ('capture', '# Capture

What to do when I ramble: a voice note, or a list of things to do.

- Turn all of it into one propose_changes call, then show me the list before anything is saved.
- Tasks go on the right person or deal, or on nothing when they are about neither. Dates are in my timezone.
- Notes ("she said", "we talked") are logged on the right person or deal.
- Stage moves go on the deal.
- Words like call, email, send, buy are tasks; ''she said'', ''we talked'' are notes; ''move to'', ''booked'' are stage moves.
- Leave out anything you are not sure of and ask me about it after showing the list.');
