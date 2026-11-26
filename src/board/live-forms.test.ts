// Forms that post in place (run 12, decision 0062): the marks public/live.js reads, and which forms carry them.
import assert from "node:assert/strict";
import { test } from "node:test";
import { postForm } from "./forms.ts";
import { html } from "./html.ts";
import { renderPage } from "./layout.ts";
import { addTaskForm, snoozeForms, taskActions } from "./task-forms.ts";

const FORM = { csrf: "t".repeat(43), here: "/" };
const inner = html`<button type="submit">Go</button>`;

test("a live form is marked data-live; an after id adds data-after and a hidden at for when scripts are off", () => {
  assert.match(postForm("f", "/x", FORM, inner, { live: {} }).value, /<form class="f" method="post" action="\/x" data-live>/);
  assert.doesNotMatch(postForm("f", "/x", FORM, inner, { live: {} }).value, /name="at"|data-after/);
  const after = postForm("f", "/x", FORM, inner, { live: { after: "task-tk_bbbbbbbbbbbb" } }).value;
  assert.match(after, /data-live data-after="task-tk_bbbbbbbbbbbb">/);
  assert.match(after, /<input type="hidden" name="at" value="task-tk_bbbbbbbbbbbb">/);
  assert.doesNotMatch(postForm("f", "/x", FORM, inner).value, /data-live|name="at"/);
});

test("every signed-in page loads /live.js with defer, before any page script; a page with no frame loads none", () => {
  const frame = { look: { name: "Pipeline" } };
  const page = renderPage({ title: "T", description: "d", body: html`<h1>T</h1>`, frame, script: true });
  assert.match(page, /<script src="\/live.js" defer><\/script>\n<script src="\/board.js" defer><\/script>\n<\/head>/);
  assert.match(renderPage({ title: "T", description: "d", body: html`<h1>T</h1>`, frame }), /<script src="\/live.js" defer><\/script>\n<\/head>/);
  assert.doesNotMatch(renderPage({ title: "T", description: "d", body: html`<h1>T</h1>` }), /live\.js/);
});

test("the Snooze, Edit and Add a task disclosures have stable ids, so they stay open across a swap", async () => {
  const task = { id: "tk_aaaaaaaaaaaa", title: "Send the plan", untrusted_fields: [], dueAt: null, description: null };
  const out = (await taskActions(task, FORM, "America/Los_Angeles")).value;
  assert.match(out, /<details class="task-snooze" id="snooze-tk_aaaaaaaaaaaa">/);
  assert.match(out, /<details class="task-edit" id="edit-tk_aaaaaaaaaaaa">/);
  assert.match(addTaskForm({ kind: "deal", id: "dl_aaaaaaaaaaaa" }, FORM).value, /<details class="add-details" id="add-dl_aaaaaaaaaaaa">/);
});

test("Done, the snooze forms, Edit save and Start timer on a task card post in place", async () => {
  const task = { id: "tk_aaaaaaaaaaaa", title: "Send the plan", untrusted_fields: [], dueAt: null, description: null };
  const out = (await taskActions(task, { ...FORM, startTimer: true }, "America/Los_Angeles")).value;
  assert.equal(out.match(/<form [^>]*data-live/g)?.length, 5, "done, start timer, two snooze forms and edit save");
  assert.match(out, /class="task-done" method="post" action="\/tasks\/tk_aaaaaaaaaaaa\/complete" data-live>/);
  assert.equal(snoozeForms(task, FORM).value.match(/data-live/g)?.length, 2);
});
