# Decision records

One short file per judgment call the spec left open: `NNNN-short-title.md`, numbered in order.

Each file has: **Context** (what the spec left open), **Decision**, **Why**, and **Consequences** (what it costs or
what to revisit). A later decision can replace an earlier one; mark the old one "Replaced by NNNN" instead of
deleting it.

## Index

One line per decision: number, title, and why in a line. Read this index and open only the decisions a task needs.
Add a line here for every new decision (`npm run check:process` fails on a decision missing from it).

- [0001](0001-board-rendered-by-worker.md) The board is HTML rendered by the Worker; Next.js is removed: live private data needs no client JavaScript, and the runtime has no dependencies. (partly replaced by 0014)
- [0002](0002-no-site-config.md) `site.config.ts` and its generator are removed, not repurposed: a tracked file of client values breaks the no-client-data rule; settings belong in the database.
- [0003](0003-robots-sitemap-no-noindex.md) robots.txt allows crawling, no noindex, and an empty sitemap: Access is the gate, not robots rules; noindex would add no privacy and would fail a required check.
- [0004](0004-mcp-endpoint.md) The MCP endpoint: the factory-per-request, stateless handler is what the current docs prescribe and needs no Durable Object. (partly replaced by 0006)
- [0005](0005-owner-emails-not-via-mcp.md) Owner emails are not changeable through MCP: owner emails decide who gets access, so no AI tool may add one; outside text could otherwise grant it.
- [0006](0006-production-auth.md) Production sign-in: Cloudflare Access guards the board and `/api`; `/mcp` uses OAuth with Access upstream, so one identity covers both.
- [0007](0007-update-mechanism.md) Many copies: provisioning, the update command, import and export: only the owner's own login reaches client accounts, so no client credential or identifier is stored outside it. (partly replaced by 0054)
- [0008](0008-data-layer.md) Data layer details (schema, test database, dev seed, clock changes): tests that run the real SQL catch constraint and query mistakes that mocks would hide.
- [0009](0009-change-records-and-undo.md) Change records and undo: one write function means no write can skip the audit row or the guard, and undo needs no per-tool code.
- [0010](0010-rules-engine.md) The rules engine: pure functions make every rule testable without a database; one change per firing keeps the audit log honest. (partly replaced by 0020)
- [0011](0011-daily-brief.md) The daily brief: composing every day keeps the board's latest brief honest, and sending stays opt-in, so nothing leaves by default.
- [0012](0012-intake.md) `POST /intake` for website forms: cheap checks first keep floods from costing database work; constant-time compare avoids leaking the secret through timing.
- [0013](0013-board.md) The board pages, its JSON API and the export: server-rendered lists need no JavaScript, and a text label keeps outside text from becoming a link or title. (partly replaced by 0014, 0015, 0021)
- [0014](0014-editable-board.md) The board becomes editable, with a little browser JavaScript: progressive enhancement keeps the board working on a slow phone or with a script error. (partly replaced by 0017, 0018)
- [0015](0015-board-look-and-navigation.md) The board's look, its navigation, and the owner's name and accent colour: cards and rows follow v3's rule that only objects get boxes, and read well on a phone in sunlight.
- [0016](0016-contacts-and-companies.md) Contacts search and sort, contact pages, the Companies view and the demo seed: searching the four fields an owner remembers people by, ignoring case, is what a phone search box should do. (partly replaced by 0027)
- [0017](0017-board-write-path-and-kanban.md) The board's write path, the change banner and the pipeline kanban: a route table and one checking function let new forms add a line and a handler, never skip a check.
- [0018](0018-board-editing.md) Editing from the board: forms, changed-fields-only edits, tasks, logging and a deal for a known contact: sending only what changed keeps untrusted_fields honest and stops one tab undoing another's edit.
- [0019](0019-home-screen-app.md) The board installs to a phone home screen: serving the manifest from the Worker keeps per-copy names and colours in D1, and nothing is cached on the phone. (partly replaced by 0030)
- [0020](0020-cpu-limits-on-a-big-copy.md) Staying inside the free plan's CPU limit on a big copy: 50 cards is already a long column; the deals that have waited longest are the ones to act on.
- [0021](0021-phone-actions-and-ask-claude.md) Phone actions (call, text, email, one tap to log) and Ask Claude: a dial string or a bare email address cannot carry a script, a second recipient or a prefilled body.
- [0022](0022-leads-on-contacts.md) Leads are people with a lead status, not a table of their own: a status on the person avoids copying records, duplicate people and a second table. (partly replaced by 0040, 0041)
- [0023](0023-adding-leads.md) Adding leads and deals: the calls 0022 leaves open: summaries and errors are the owner's record of what happened, so 'lead' has to mean one thing in them.
- [0024](0024-qualify-and-return.md) Qualifying a lead and moving a deal back to leads: the calls 0022 leaves open: refusing details that would be thrown away keeps 'do what I said' honest.
- [0025](0025-lead-reads.md) How the lead reads count: reusing the gone_quiet test and the company grouping keeps every number in step with the ones the owner knows.
- [0026](0026-lead-followup-rule.md) The lead_followup rule: a strict > on the status time keeps the call that caused a status from cancelling the reminder about it.
- [0027](0027-people-views.md) The People tab (Contacts, Leads, Companies) and the Leads list: One People tab with three views keeps the phone tab bar at five items and gives leads their own place.
- [0028](0028-lead-pages.md) A lead's page, the status menu, Qualify, Add a lead or a deal, and Back to leads on the board: Plain board wording keeps internal names off the screen, and a Qualified person's status shows as history.
- [0029](0029-leads-import-and-seed.md) Leads in the import, export and demo seed: Making status columns work without a flag keeps export-then-import lossless; the duplicate check covers leads only.
- [0030](0030-brief-notification.md) A phone notification when the daily brief is ready (web push): The owner asked for it; a fixed notification tells the phone only that a brief exists, and caches nothing.
- [0031](0031-email-logging.md) Email logging by BCC: Cloudflare's own header is the only sender check a Worker can trust, so strangers' mail is dropped unread.
- [0032](0032-what-it-caught.md) What it caught, a monthly report: Counts use the owner's calendar months and count only reaches within 7 days, so old, unrelated calls do not count.
- [0033](0033-contacts-search-leads-hint.md) A Contacts search that finds only leads points to Leads: One line pointing to Leads stops the owner adding a lead twice, without mixing leads into Contacts.
- [0034](0034-import-engine.md) One import engine: One engine means the deals, tasks and board imports clean and refuse rows exactly like the contact import.
- [0035](0035-one-change-at-any-size.md) One change at any size: Each statement stays under D1's limits however many rows there are, so a 2,000-row import is one audited change.
- [0036](0036-board-import.md) Import people on the board: The file waits in D1, not in URLs or cookies; apply plans again against current data. (partly replaced by 0037)
- [0037](0037-deals-and-tasks-import.md) Import deals and tasks: Ids are the only safe key for matching deals and tasks, so re-importing the same file changes nothing.
- [0038](0038-my-own-list.md) "This is my own list": A list from outside must not become trusted names, so the box is unticked and values are capped and plain.
- [0039](0039-mcp-import.md) Import over MCP: Reusing the import drafts keeps one guarded store and one apply path, so MCP imports need no new code paths.
- [0040](0040-person-status.md) Person status: Keeping lead_status as the engine's column leaves run 4's rules, reports and views working, and one function prevents drift.
- [0041](0041-person-tools-and-board.md) Person status tools and board: One label lookup makes a rename show everywhere at once; grouped options keep the status fields honest without JavaScript.
- [0042](0042-saved-views.md) Saved views: Stored keys survive renames, and default views computed on read show a new status with no code.
- [0043](0043-table-layout.md) Table layout: A real table gives screen-reader and keyboard users the fields they need, and a scrolling region keeps phones usable.
- [0044](0044-approve-before-change.md) Approve before change (proposals): Planning through the ordinary services means a proposal can never write what the tool itself would refuse. (partly replaced by 0045)
- [0045](0045-ai-edits-setting.md) The "AI edits" setting (record tools propose): Review first by default means no yes-less writes; small taps like logging a call apply at once.
- [0046](0046-standalone-tasks.md) Standalone tasks: Owners keep personal and business to-dos in one list, without inventing a fake contact to attach them to.
- [0047](0047-today-list.md) Today works like a list: One place shows everything to do, including tasks with no due date, which the old view hid.
- [0048](0048-capture.md) Capture through the AI app: A ramble becomes one proposal the owner approves, so guesses about names become questions, not writes.
- [0049](0049-time-and-rates.md) Time entries, the timer, work types and client rates: A running timer is just an entry with no end; rates are fixed on save, so billed time stays billed.
- [0050](0050-timer-on-the-board.md) The timer on the board: Same services give one audit row and undo per tap; a bar on every page shows a running timer.
- [0051](0051-time-pages.md) Time pages, hand entry and the time CSV: A week suits "what did I do" and a month suits billing, so the CSV is monthly.
- [0052](0052-fast-checks-and-change-aware-audits.md) Fast commit check, one e2e Worker and change-aware audits: the slow parts were setup, not testing; the full suite still runs before every push, in CI and on main.
- [0053](0053-campaigns.md) Campaigns, step 1: Only the board sends, every email can be unsubscribed from, and a frozen list with one row per person means no one gets an email twice.
- [0054](0054-managed-hosting.md) Managed hosting: every copy lives in Huston Logic's Cloudflare account, because owners want it handled and one paid account costs about the same however many copies it holds; offboarding moves a copy to the client's own accounts.
- [0055](0055-projects.md) Projects: delivery after the sale, kept apart from selling; a project is its own record, so a won deal stays won. (partly replaced by 0056)
- [0056](0056-projects-shaped.md) Projects, shaped by the owner: statuses with open or closed kinds, custom fields and saved views on projects, internal projects with no person, and the Won flow into Start a project.
- [0057](0057-subtasks.md) Sub-tasks on projects: a sub-task is an ordinary task with a parent and a position, completing a parent asks about its open sub-tasks, and the board shows three levels.
- [0058](0058-task-plans.md) Task plans: `add_task_plan` adds a whole project's tasks as one flat list with `under` numbers, at most 100 tasks a proposal, `dueDays` from the project start, and the capture rulebook updated only when unchanged.
- [0059](0059-project-templates.md) Project templates: saved task trees copied into a project by `add_project {template}` with no link back, MCP and board pages to keep them, and a template choice with a preview on Start a project.
- [0060](0060-board-approval.md) Board approval: the `ai_approval` setting (In chat by default), the Pending changes page where the owner approves or discards a proposal, and the AI's apply, import and undo refusing under "On the board only".
- [0061](0061-board-approval-strict.md) "On the board only" made strict: small changes and the rule tools (`add_rule`, `update_rule`, `pause_rule`, `resume_rule`) wait for approval on the board; In chat is unchanged.
- [0062](0062-layout-and-ease.md) Layout and ease of use (run 12): task descriptions and edits, actions in place, the status corner, one task row, new navigation and the brief switch: the brief's calls are made once here, each with its cost to change, so the build follows one list.
