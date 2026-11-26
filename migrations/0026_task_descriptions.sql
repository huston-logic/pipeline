-- 0026: a task may carry a description (steps and detail, up to 10,000 characters, line breaks kept), and so may a
-- template task. Both columns start empty on every existing row. The capture document gains one line about keeping
-- titles short; only a document that still has exactly 0023's text is updated, so an owner's edit keeps every word.
-- This is not an audited change. seed/defaults.sql has the new text for new copies (a test checks).

ALTER TABLE tasks ADD COLUMN description TEXT CHECK (description IS NULL OR length(description) BETWEEN 1 AND 10000);
ALTER TABLE template_tasks ADD COLUMN description TEXT CHECK (description IS NULL OR length(description) BETWEEN 1 AND 10000);

UPDATE rulebook SET
  markdown = replace(
    markdown,
    '- Leave out anything you are not sure of and ask me about it after showing the list.',
    '- Leave out anything you are not sure of and ask me about it after showing the list.
- Keep a task''s title short, about 80 characters at most, and put steps and detail in its description.'
  ),
  version = version + 1,
  updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE name = 'capture' AND markdown = '# Capture

What to do when I ramble: a voice note, or a list of things to do.

- Turn all of it into one propose_changes call, then show me the list before anything is saved.
- Tasks go on the right person or deal, or on nothing when they are about neither. Dates are in my timezone.
- Notes ("she said", "we talked") are logged on the right person or deal.
- Stage moves go on the deal.
- Words like call, email, send, buy are tasks; ''she said'', ''we talked'' are notes; ''move to'', ''booked'' are stage moves.
- Leave out anything you are not sure of and ask me about it after showing the list.

## Planning a project

When I describe the work of a project, use one add_task_plan (after add_project, if the project is new) instead of many add_task actions.

- List every task in the order it happens. A step that belongs to a bigger task goes under it: set its under to the number of that task in the list.
- Use dueDays (days after the project''s start date) when I give a pace instead of dates, and only when the project has a start date.
- Show me the list before anything is saved.

Example: "Kitchen remodel for the Example family, starting December 1. Order cabinets first. Demolition is next, with removing the old counters as part of it. Paint after that, two days after the start." is one add_project and one add_task_plan with three tasks: "Order cabinets", "Demolition", "Paint" (due 2 days after the start), and a fourth, "Remove the old counters", with under set to 2.';
