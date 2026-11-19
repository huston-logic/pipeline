---
name: human-touch-design
description: Use for ANY UI, design, layout, styling, typography, color, motion, component or page work in this repo, and whenever the user asks for a design audit. Treats any style guide, AGENTS.md, CLAUDE.md and the design tokens as the brief, never invents or rewrites copy, flags every match with the "AI defaults" list with 1-2 alternatives (the owner decides), and has a read-only audit mode.
license: Apache-2.0. Complete terms in LICENSE.txt
---

> **Modified from Anthropic's `frontend-design` v1.1.1 (Apache License 2.0).** Changes: (1) description now triggers on any UI or design work in this repo; (2) the brief is any style guide, AGENTS.md, CLAUDE.md and the current design tokens, with tokens-only and system-fonts-only rules; (3) the instruction to invent copy is replaced by a never-invent-copy rule, with `[[placeholders]]` for unknowns; (4) matches with the "AI defaults" list are flagged with 1-2 alternatives and never forced out, and brief-required matches are built as specified and labeled STYLE DECISION for the owner; (5) a "Kept on purpose" record and a KEPT by owner label were added; (6) the palette and typeface steps use existing tokens instead of new hex values and fonts, and business facts are read from the repo instead of hard-coded; (7) an audit mode was added; (8) adapted to the pipeline engine's board (Worker-rendered HTML, `public/board.css`, system fonts, the board copy rule and the plan-approval rules from `CLAUDE.md`). The calibration list, process, restraint and writing sections are kept.

# Human-Touch Design

Approach this as the design lead at a small studio known for work that feels made by a person, for one specific client, and never mistaken for a template. Make deliberate, opinionated choices inside the limits of the brief below. Spend creativity on layout, rhythm, hierarchy and restraint, not on new colors, new fonts or new words.

## The brief (read it first, every time)

The brief for this repo is, in order of authority for design questions:

1. **A style guide, if the repo has one** (for example `STYLE-GUIDE.md`, or a `design-v2/` folder; look at the repo root and any `docs/` folder). It is part of the brief and outranks the design-token section of `AGENTS.md`.
2. `AGENTS.md` (imported by `CLAUDE.md`) and `CLAUDE.md`.
3. The design tokens: the `:root` tokens in `public/board.css` (the only stylesheet), and the owner's accent colour, which is a setting in the database, not code.

Read these before designing. Do not rely on values quoted in this skill or on memory. If `CLAUDE.md` or a style guide says a design migration is in progress, parts of `AGENTS.md` (especially its design-token and motion sections) may be out of date. If brief files disagree with each other beyond that ordering, say so to the owner; never edit a brief file to make a disagreement go away.

This repo is the pipeline engine, not a website: the board is HTML rendered by the Worker (`src/board/`), styled by `public/board.css`, with one small first-party script (`public/board.js`, decision 0014). Every copy runs identical code, so the business name and accent colour are settings in each copy's database (`docs/SPEC.md`); never hard-code a business name or fact. What the board shows comes from `docs/SPEC.md`.

Hard rules from the brief:
- Tokens only. Never hard-code hex values, radii, shadows, durations or easing outside the `:root` tokens in `public/board.css`. Use the named tokens, plus any exceptions the brief documents.
- System fonts only (the `--font` token). No web fonts and no third-party font, style or script.
- Markup only through the `html` tag (`src/board/html.ts`); shared patterns become small functions (like `src/board/parts.ts`), not copied markup. No framework, no animation, component or CSS-in-JS libraries.
- Every action works as a plain HTML form; `board.js` only adds conveniences. Follow the motion rules in the brief (tokens, reduced motion).
- Follow the workflow in `CLAUDE.md` (branch, `npm run check` before every commit, PR, never merge; its "Decision authority" section says when to ask).

## Copy rule (non-negotiable)

- Board copy (labels, buttons, headings, messages) is plain and short, sentence case, no emoji, and adds no claims the spec does not make (`CLAUDE.md`). Write new board copy to that rule; never invent features, numbers or promises.
- Never change the meaning of existing copy without the owner (`CLAUDE.md`, "Decision authority"). Data on the board (names, deals, notes) is shown as stored, never rewritten.
- Anything unknown becomes a visible `[[double-bracket placeholder]]`. Do not delete a placeholder to hide a gap, and do not fill one with a guess.
- Copy ideas may appear in a plan or an audit only, each labeled **COPY IDEA (not for code)**. They never go into code, comments, alt text, metadata or content files.
- The writing principles below are for judging and for suggesting labeled ideas. Never use them to change the meaning of existing copy.
- All other content rules in `AGENTS.md` (pricing, testimonials, claims, voice) still apply and win.

## AI defaults: flag, never force

The calibration list below names patterns that read as generated. Whenever a design choice matches one of them (or one of the typographic or motion tells under Design principles), call it out and give 1-2 prepared alternatives, each with a one-line reason. This applies in build mode and in audit mode, and whether or not the brief requires the choice. The owner decides. Never silently pick a side, and never remove or replace a brief-required choice on your own.

Use these labels:
- **FLAGGED**: the match is your own free choice (the brief does not require it). In build mode, put the flag in the plan with the alternatives. When `CLAUDE.md` has you wait for plan approval, that approval is the decision; when it has you decide yourself (the fast lane, autonomous runs), prefer an alternative, and list any flagged default you still build, with its alternatives, in the PR description so the owner sees it.
- **STYLE DECISION for the owner**: the brief, a style guide or the tokens require it. Build it exactly as specified, and show the flag with the alternatives and the file and line that require it.
- **KEPT by owner**: the owner chose to keep it (see below). Do not re-flag it; keep respecting it.

## Kept on purpose

If the owner wants to keep an AI default, respect that. Record it in a "Kept on purpose" section, in the style guide if the repo has one, otherwise in `CLAUDE.md`. Each entry is the item plus a one-line reason (`- <item>: <reason>`).

- Read this section before planning and before every audit. Anything listed is marked **KEPT by owner** and is not re-flagged.
- Add an entry only when the owner explicitly says to keep something. Never on your own initiative, and never in audit mode (print the proposed line instead).
- If the section does not exist yet, create it with that heading. Editing `CLAUDE.md` or a style guide follows the normal workflow (branch, plan, PR).

## Ground your designs in the subject matter

Take the product and its facts only from the repo files named above (`docs/SPEC.md`, `AGENTS.md`, the style guide). The subject is a small-business owner's daily sales follow-up screen on a phone; its vernacular (deals, stages, follow-ups, today) is where distinctive visual choices come from. Build with the fake seed data (`npm run dev`) throughout, and use `[[placeholders]]` where content does not exist yet. Never invent an audience, an offer or a claim.

## Design principles

For web designs, the hero is the first thing viewers will see. Open with the most characteristic thing in the subject's world, in the form that is most appropriate. Be deliberate: a big number with a small label, supporting stats, and a gradient accent is the default treatment, so only use it if that is truly the best option.

Typography carries the personality of the page. Use the fonts the brief already loads and set a clear type scale following the default guidance of The Elements of Typographic Style, with intentional weights, widths and spacing. When type is used as a headline or visual element, use the type treatment itself as an active part of the design, not a neutral delivery vehicle for the content.

Default to line lengths of less than 80 characters. Serif typefaces can have slightly longer line lengths; give serif body text slightly more line-height than a sans-serif.

Avoid these default typographic treatments; they are the commonest tells of a generated page:
- Accenting just a single word or phrase in a headline, like putting one word in italic/bold or a different color.
- Using all caps for labels.
- Adding unnecessary typographic labels above content.

Visual structure is information. Structural devices like outlines, borders, numbering, eyebrows, dividers, labels, etc., encode useful information about the content rather than decorate it. Many generic designs use numbered markers (01 / 02 / 03), but that is only appropriate if the content actually is a sequence, like a stepped process or a timeline. Before adding numbered markers, check the content really is a sequence.

Use non-user-triggered motion sparingly and deliberately, only to draw attention. A single orchestrated moment, one page-load sequence or one reveal, lands better than scattered effects; fade-and-slide-up entrances on each section and hover transitions on every card are the generic default and read as AI-generated. Motion that answers a person's action (opening, expanding, confirming) is welcome when it shows what changed. All motion uses the shared components and tokens in the brief.

## Process: plan, review against the brief, build, critique

For calibration, AI-generated design right now clusters around some traits:
1. a warm cream background (near #F4F1EA) with a high-contrast serif display and a terracotta or warm-clay accent (often near #D97757, Anthropic's own Claude-interaction accent, so on a user's brief it reads as a tell);
2. a near-black background with a single bright acid-green or vermilion accent;
3. a broadsheet-style layout with hairline rules, zero border-radius, and dense newspaper-like columns;
4. the SaaS-card kit: content chopped into identical rounded cards, one border-radius on everything regardless of hierarchy, the same soft grey shadow (rgba(0,0,0,.1)) under each, and gradient washes as decoration;
5. template chrome that appears whatever the subject: a tracked-out ALL-CAPS eyebrow label above every heading; meta strings joined with middle dots ('A · B · C'); labels built as 'WORD — fragment' with a spaced em dash; tinted near-black (#0B0B0B, #111) standing in for black; a monospace face for small data labels; a '→' appended to link and button text.

All traits are legitimate for some briefs, but they are defaults rather than choices, and they appear regardless of subject. Where the brief pins down a visual direction, follow it exactly; the brief's own words always win, including when it asks for one of these looks. Flag the overlap as described under "AI defaults: flag, never force" so the owner decides knowingly. Where the brief leaves an axis free, do not spend that freedom on one of these defaults.

Work in passes, and put them in the plan (`CLAUDE.md` says whether the owner approves it first). First, brainstorm a short design plan built from the brief:
- Color: which existing tokens, by name, and what role each plays. Do not introduce new hex values.
- Type: which loaded fonts, by token name, and their roles.
- Layout: a layout concept, using one-sentence prose descriptions and ASCII wireframes to ideate and compare. Include alignment guidance: left aligned, center aligned, justified?
- Content: which board strings the design uses or adds, and which `[[placeholders]]` it needs. Copy ideas, if any, labeled **COPY IDEA (not for code)**.
- Principles: the high-level guidance for what makes this page unique.
- AI-default flags: every FLAGGED and STYLE DECISION item, each with 1-2 alternatives and a one-line reason. Skip anything listed as KEPT by owner.

Then review that plan against the brief and against the AI-defaults list before building: if any part reads like the generic default you would produce for any similar page rather than a choice made for this brief, revise it, say what you changed and why, and flag what remains. Then write the code, following the plan; when `CLAUDE.md` asks for approval first, only after the owner approves it.

When writing the code, be careful of structuring your CSS selector specificities. It is easy to generate CSS classes that cancel each other out (especially with a type-based selector like .section and an element-based selector like .cta). This can happen often with padding/margin between sections.

Finally, critique your own work: view it at mobile and desktop widths, check keyboard focus and reduced motion, and run `npm run check`.

## Restraint and self-critique

Spend your boldness in one place. Let one element be the memorable thing, keep everything around it quiet and disciplined, and cut any decoration that does not serve the brief. Build to a quality floor without announcing it: responsive down to mobile, visible keyboard focus, reduced motion respected, visually accessible, harmonious color palettes. Critique your own work as you build, taking screenshots to review if your environment supports it. Consider Chanel's advice: before leaving the house, take a look in the mirror and remove one accessory.

## More on writing in design

Words appear in a design for one reason: to make it easier to understand and use. They are design content, not decoration. Bring the same intentionality and minimalism to copywriting that you would bring to spacing and color. Before suggesting anything, ask what the design needs to say, and how it can best be said to help the person navigate the experience. (Remember the copy rule: plain and short, no claims the spec does not make, and never change the meaning of existing copy without the owner.)

Write from the end user's perspective. Name things by what users will understand in simple language, not by how the system is built. Describe what something is or does in plain terms rather than selling it. Being specific and legible to new users is always better than being clever.

Use active voice as default. A CTA says exactly what happens when it is used: "Save changes," not "Submit." An action keeps the same name through the whole flow. The vocabulary of an interface is the signposting for someone navigating the product. Cohesion and consistency are how people learn their way around.

Treat failure and emptiness as moments for direction, not mood. Explain what went wrong and how to fix it, in the interface's voice rather than a person's. Errors do not apologize, and they are never vague about what happened. An empty screen is an invitation to act.

Keep the tone conversational: plain verbs, sentence case, no filler, with tone matched to the brand and the audience. Let each written element do exactly one job.

## AUDIT MODE

**Trigger:** the owner asks for a design audit (for example "design audit", "audit the design", "where does this look AI-generated"). The owner may name a page or area; audit only that scope.

**Read-only.** In audit mode change nothing: no edits, no new files, no branches, no commits, no formatting runs, no package installs, and no new "Kept on purpose" entries (print the proposed line instead). Use only reading and searching (Read, Grep, Glob, and read-only shell commands such as `git ls-files`). This is an instruction to you, not an enforced lock, so if a step seems to need a change, stop and ask.

**Scope (unless the owner narrows it):** `src/board/**` (layout, parts and pages; copy tells included) and `public/` (`board.css`, `board.js`). Read the brief files and the "Kept on purpose" section first. Verify every finding by reading the actual code; never report from memory or assumption. Mark anything you could not confirm as `unsure`.

**What to look for:** every place the site matches an item on the AI-defaults list (cream plus serif plus terracotta; near-black plus one bright accent; broadsheet hairlines and zero radius; identical rounded cards, one radius everywhere, the same soft shadow, gradient washes; template chrome such as ALL-CAPS eyebrows, middle-dot meta strings, 'WORD — fragment' labels, tinted near-black, monospace data labels, `→` on links), plus the typographic and motion tells listed under Design principles (single-word headline accents, ALL-CAPS labels, unneeded labels above content, numbered markers on non-sequences, fade-and-slide-up on every section, hover transitions on every card).

**For each finding, report:**
- **Where:** page route, component, and `file:line`.
- **Matches:** which AI default (its number from the list, or the principle).
- **Why it reads as generated:** one or two plain sentences.
- **Alternatives:** 1-2 human-feeling options that fit the brand and stay inside the brief (existing tokens, loaded fonts, shared components), each with a one-line reason. Describe layout, structure or treatment. Any wording idea is labeled **COPY IDEA (not for code)**; never invent facts about the business.
- **Status:** `flagged` (free choice), `STYLE DECISION` (the brief requires it; cite the file and line), or `KEPT by owner` (listed under "Kept on purpose"; list it in one line and do not re-flag).

Never recommend removing a brief-required choice; show the alternatives and leave the decision to the owner.

**Output:** a report in the chat, grouped by page, then a "Style decisions for the owner" section collecting every STYLE DECISION, then a short summary (counts by AI-default number and which three changes would make the biggest difference). Do not fix anything, open a PR, or start a plan unless the owner asks.
