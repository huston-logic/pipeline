# 0021: Phone actions (call, text, email, one tap to log) and Ask Claude

Run 2, task R5, 2026-11-19. Builds on 0013 (outside text), 0014 (a little JavaScript), 0017 (the write path) and 0018
(the Log route). Number 0019 is task R6's and 0020 task R7's. Amends 0013's rule that outside text is never a link's
target, for three schemes only.

## Context

The run 2 spec asks for phone actions: call, text or email a contact through the phone's own apps, then one tap to log
it, and "Ask Claude" links that open the owner's AI app with a prompt filled in, plus "Copy prompt", with no AI calls
inside the product. It left open which values may become links (a contact's phone and email often came from a website
form, and 0013 forbids outside text as a link target), how a text is logged (the schema has no text type), what the
prompts say, how Ask Claude opens, and how copying works without JavaScript.

## Decision

- **Where.** The deal page's Contact card and the contact page's Details card end with the phone actions
  (`src/board/reach.ts`), under the card's facts and above its link: Call, Text and Email links in one row, then the
  one-tap Log buttons in a row below, one column per channel. Phone (under 60rem): filled accent buttons 56px tall in
  equal columns. Wide: the same columns as quiet white buttons 44px tall. The deal page also has an "Ask
  Claude" section after Next step (`src/board/ask-claude.ts`). The contact page has no Ask Claude: both prompts are
  about a deal.
- **Outside values as link targets, narrowly** (amends 0013). A phone number or email address, outside text or not,
  becomes a `tel:`, `sms:` or `mailto:` target only after a strict check; anything that fails gets no button:
  - Phone: remove ASCII spaces, `-`, `.`, `(` and `)`; what is left must be an optional leading `+` and 7 to 15 ASCII
    digits (`^\+?[0-9]{7,15}$`; 15 is E.164's longest). Letters, `;ext=`, `?`, `%`, `#`, `,`, a second `+`, tabs,
    non-breaking spaces, and non-ASCII digits (Arabic-Indic, full-width) are refused, so nothing but a dial string
    reaches the phone. `tel:` and `sms:` get the cleaned value.
  - Email: `local@domain`. The local part is 1 to 64 characters: runs of letters, digits, `_`, `+` and `-` joined by
    single dots (no leading, trailing or doubled `.`). The domain is two or more labels of letters, digits and `-`
    (not starting or ending with `-`) joined by single dots. 254 characters at most in all.
    So no `?`, `&`, `%`, `#`, quotes, spaces, slashes, backslashes, angle brackets or non-ASCII letters. `mailto:` gets
    the address as stored, with no subject, body or other query.
  - The link text is fixed ("Call", "Text", "Email"), never the value; the value is shown separately, in the card's
    own Phone and Email rows just above the buttons, labelled "From outside" when it is (so it isn't repeated). The href goes through the `html` tag like every
    attribute. Only these three schemes are allowed; no other outside text becomes a link.
  - When a value is on file but fails the check, the card says so in one line ("The phone number can't be dialled as
    written, so there is no Call or Text button. Edit the contact to fix it."), so a missing button is not a mystery.
    No value, no line. Intake accepts `robin@exa_mple.com` (0018), which has no Email button for this reason.
- **One tap to log it.** Under the links, "Log the call", "Log the text" and "Log the email" are one-button POST forms
  to R4's log route (`/deals/<id>/log` on the deal page, `/contacts/<id>/log` on the contact page), with fixed hidden
  values: type `call` and "Called.", type `note` and "Sent a text message.", type `email` and "Sent an email.". The
  time is now (both date fields absent). They go through the route table like every board write: sign-in, same origin,
  CSRF token, one `log_activity` change by the owner, then the banner and Undo. A Log button shows only for a channel
  that has its link (no "Log the text" without a usable phone); the full Log form is still there for anything else.
  The hint line says "Called, texted or emailed? Log it in one tap." (or the part that applies), and the buttons are
  always visible, so it all works without JavaScript.
- **No text type.** The activities schema has form, email, call, meeting, note, stage_change and system. A text is
  logged as a `note` with the summary "Sent a text message."; adding a type would need a migration and a change to
  the MCP tools for one label. Revisit if the owner wants to filter texts.
- **The script.** `public/board.js` gains a second block, and the deal and contact pages now load the file (with
  `defer`, as the pipeline board does; still one file, under 3 KB gzipped, no innerHTML, eval or fetch). Tapping Call,
  Text or Email moves focus to the matching Log button and marks it (`is-next`: the button turns into the filled
  accent button), so the next tap logs it; the link still opens the phone's app as normal.
- **Ask Claude.** Two links, "Prep me for this call" and "Draft a follow-up in my voice", to
  `https://claude.ai/new?q=` plus `encodeURIComponent(prompt)`, with `target="_blank" rel="noopener noreferrer"` and
  "(opens Claude in a new tab)" in hidden text. The prompts are fixed sentences around the deal id only:
  - "Use my pipeline tools: read get_deal for dl_… and my rulebook, then prep me for my call: who they are, where the
    deal stands, open tasks, and three questions to ask."
  - "Use my pipeline tools: read my rulebook (voice) and get_deal for dl_…, then draft a short follow-up email in my
    voice. Don't send it; show me the draft."
  No name, email, deal title or any other record text goes in the URL or the prompt: a URL ends up in browser history
  and in claude.ai's logs, and outside text in a prompt would be an injection path. The AI reads the deal through the
  MCP tools, which label outside text. An id that is not a deal id gives no prompts.
- **Copy prompt.** Without JavaScript, each prompt sits in a labelled read-only `<textarea>` inside a `<details>`
  ("Show the prompt"), to select and copy by hand. With it, a "Copy prompt" button (in the markup with `hidden`, shown
  by the script only when `navigator.clipboard` exists, so there is never a dead button) writes the textarea's value
  to the clipboard and says "Copied." in an `aria-live="polite"` line beside it, or how to copy by hand when the
  browser refuses. No alert, no pop-up, nothing that disappears on its own. The copied prompt works in any AI app that
  has the pipeline's MCP connector added, not only Claude.
- **No AI in the product.** The board only builds links and text; it calls no model and sends nothing anywhere.

## Why

- A dial string of `+` and digits, and an address with no query, can't carry a script, a second recipient or a
  prefilled body, which is the risk in letting outside text become a link. Refusing anything unusual costs a button
  for an odd value, not safety; the value is still shown and can be fixed.
- One-tap logging through the existing route keeps one write path, the audit row and Undo, and needs no new tool.
- Fixed prompts with an id only keep record text out of URLs and out of the AI's instructions; the MCP tools already
  give the AI the deal with its outside-text labels.

## Consequences

- **STOP item for the owner:** `claude.ai/new?q=` filling in the prompt is claude.ai's behaviour as used at the time of
  writing, not a documented API. Check it on your phone (Safari and the Claude app, if installed, may handle the link
  differently); if it stops working, Copy prompt still does.
- `tel:` and `sms:` need a phone (or a desktop with a calling app); on a desktop without one the link does nothing
  harmful. That is why the buttons are quieter on wide screens.
- A number stored without its country code (`555-0101`) dials as a local number.
- The deal and contact pages now load `/board.js`; their Lighthouse and a11y runs include it.
- Two quick taps on a Log button write two activities (each its own change); Undo on the banner removes one.
- A phone number from outside could be a premium-rate number. It is labelled "From outside" in the card right above
  the buttons, so the owner decides before tapping Call.

## "AI defaults" (human-touch-design), flagged for the owner

- **Three equal filled buttons in a row on the phone** (close to item 4, identical rounded shapes). My choice, for a
  thumb-sized action bar like a phone's contact screen. Alternatives: only Call filled and Text and Email quiet; or
  the three as one segmented white strip with dividers.
- **Two-line Log labels on a phone** ("Log the / email" in a 56px tile), because three equal columns at 375px are
  about 96px wide. Alternatives: the Log row as one column of full-width buttons; or shorter visible labels ("Log
  call") with the full words in hidden text.
- **The Log buttons as quiet outline buttons that turn filled after a tap.** My choice. Alternatives: Log buttons
  always filled; or a single "Log it" button with the channel chosen from a short select.
- **Ask Claude rows on one white panel with dividers** (item 3, hairlines). Alternatives: two cards; or the two links
  as a plain list under the heading with the prompts in one disclosure.
- Not used: phone, message or mail icons (the icon set in the style guide §8 is closed), floating action buttons,
  toasts, a "sparkle" AI badge.
