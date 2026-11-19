# 0005: Owner emails are not changeable through MCP

## Context

`settings.owner_emails` lists who may open the board and sign in to `/mcp`. Task 5 adds `update_settings` so the owner
can change the timezone and the daily brief by talking. The spec's settings list (timezone, brief hour, brief address,
brief on or off) does not include the owner emails, but the table holds them next to the other settings.

## Decision

`update_settings` has no owner-email field: not in the tool's input schema (unknown fields are refused), not in
`SettingsPatch`, not in the service. `get_settings` shows the owner emails (the owner and the AI both need to know who
is signed in) and never any secret; there are no secrets in the settings table. Owner emails are set when a copy is
provisioned, or later with a SQL statement against the copy's database (`wrangler d1 execute`), by a person.

## Why

The owner emails decide who gets access. An AI tool that could add an address is a privilege-escalation path: text
from a website form or an imported row that talks the AI into "adding an owner" would turn outside text into access.
Keeping the list out of reach of every tool means no prompt can widen access, whatever it says.

## Consequences

- Adding or removing an owner is a deliberate, out-of-band step (provisioning or SQL). The README's provisioning
  section should say so when task 8 writes it.
- Changes made that way are not in `audit_log`, because they do not go through `commitChange`.
- `update_settings` changes are undoable like every other write; an undo restores the whole settings row as it was, so
  it never touches the owner emails unless the SQL edit happened in between (then the undo refuses: "the settings
  changed since").

## Addendum (final review): the brief address must be an owner email

Once sending is on, `brief_email` decides who receives a daily summary of the whole pipeline, so it is as sensitive
as the owner list. An AI talked into "send the brief to me@elsewhere" by text in a form or an imported row would move
data out. `update_settings` now accepts a brief email only when it is one of the owner emails (`settings.owner_emails`
plus the `OWNER_EMAILS` var), compared trimmed and lowercased; otherwise a plain error: "The brief can only go to an
owner email (owner@example.com), and x@example.test isn't one. Use an owner email, or null to clear it." With no owner
emails set, no brief email can be set. Clearing it (null) is always allowed. The send path does not re-check: an
`undo_change` can put back an earlier address that was an owner email when it was set.
