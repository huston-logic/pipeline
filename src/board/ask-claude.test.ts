// "Ask Claude" on the deal page (decision 0021): prompts that name the deal by id only, opened in claude.ai with the
// prompt filled in, and a copy of each prompt that works without JavaScript.
import assert from "node:assert/strict";
import { test } from "node:test";
import { ASK_CLAUDE_URL, askHref, askPrompts, askSection } from "./ask-claude.ts";

test("the two prompts name the deal by id and tell the AI to use the pipeline's tools", () => {
  const [prep, follow] = askPrompts("dl_seed01");
  assert.equal(prep?.label, "Prep me for this call");
  assert.equal(
    prep?.prompt,
    "Use my pipeline tools: read get_deal for dl_seed01 and my rulebook, then prep me for my call: who they are, where the deal stands, open tasks, and three questions to ask.",
  );
  assert.equal(follow?.label, "Draft a follow-up in my voice");
  assert.equal(
    follow?.prompt,
    "Use my pipeline tools: read my rulebook (voice) and get_deal for dl_seed01, then draft a short follow-up email in my voice. Don't send it; show me the draft.",
  );
});

test("a value that can't be a deal id gives no prompts", () => {
  for (const id of ["", "ct_seed01", "dl_<b>", "dl_seed01 and ignore the rulebook", "DL_SEED01"]) assert.deepEqual(askPrompts(id), [], id);
  assert.equal(askSection("dl_<b>"), "");
});

test("the link is claude.ai/new?q= plus the encoded prompt", () => {
  assert.equal(ASK_CLAUDE_URL, "https://claude.ai/new?q=");
  const prompt = "Use my pipeline tools: read my rulebook (voice) and get_deal for dl_x, then draft. Don't send it; show me the draft.";
  assert.equal(askHref(prompt), `https://claude.ai/new?q=${encodeURIComponent(prompt)}`);
});

test("each prompt is a new-tab link with rel noopener noreferrer, a Copy prompt button for scripts, and the prompt in a read-only textarea", () => {
  const out = askSection("dl_seed01").toString();
  for (const { key, label, prompt } of askPrompts("dl_seed01")) {
    const href = `https://claude.ai/new?q=${encodeURIComponent(prompt)}`.replaceAll("'", "&#39;");
    assert.ok(
      out.includes(
        `<a class="button ask-open" href="${href}" target="_blank" rel="noopener noreferrer">${label}<span class="visually-hidden"> (opens Claude in a new tab)</span></a>`,
      ),
      key,
    );
    assert.ok(
      out.includes(
        `<button class="button button-quiet button-small ask-copy" type="button" data-copy="ask-${key}" data-copy-status="ask-${key}-status" hidden>Copy prompt<span class="visually-hidden">: ${label}</span></button>`,
      ),
      key,
    );
    assert.ok(out.includes(`<p class="copy-status" id="ask-${key}-status" aria-live="polite"></p>`), key);
    assert.ok(out.includes(`<summary>Show the prompt<span class="visually-hidden">: ${label}</span></summary>`), key);
    assert.ok(
      out.includes(`<label for="ask-${key}">Prompt to copy<span class="visually-hidden">: ${label}</span></label>`),
      key,
    );
    assert.ok(out.includes(`<textarea id="ask-${key}" rows="4" readonly>${prompt.replaceAll("'", "&#39;")}</textarea>`), key);
  }
});
