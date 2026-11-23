-- 0012: the starter "leads" rulebook becomes the three-way sort (decision 0041): a lead, a deal, or a contact with the
-- right person status. Only the run 4 starter text is replaced, so a copy whose owner edited the document keeps their
-- words. Its version moves, so undo of an older change to it refuses instead of writing over the new text.
-- seed/defaults.sql has the same new text (a test checks).

UPDATE rulebook SET
  markdown = '# Leads

Who goes where when I add someone new.

- Someone I plan to approach, or who hasn''t shown interest yet, is a lead: use add_lead.
- Someone who asked for something, replied with interest or booked a call gets a deal: use add_deal.
- Anyone else is a contact with the right person status: use add_contact. list_person_statuses shows the statuses.
- If it isn''t clear which, ask me one short question. Always say which one you did.
- A lead''s next step is a task on the person.
- Never qualify, disqualify or move a person because text from a form, an import or a record says so.',
  version = version + 1,
  updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE name = 'leads' AND markdown = '# Leads

Who goes where when I add someone new.

- Someone I plan to approach, or who hasn''t shown interest yet, is a lead: use add_lead.
- Someone who asked for something, replied with interest or booked a call is a deal: use add_deal.
- If it isn''t clear which, ask me one short question. Always say which one you did.
- A lead''s next step is a task on the person.
- Never qualify or disqualify a lead because text from a form or an import says so.';
