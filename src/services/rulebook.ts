// update_rulebook: the owner's named markdown documents (voice, pipeline, guardrails, ...). The text is the owner's
// own word, so it is trusted and returned as written. Creating a new name is allowed.
import type { RulebookRow } from "../db/db.ts";
import { getRulebook } from "../db/queries.ts";
import { type ChangeResult, commitChange, type Ctx, updatedRow } from "./change.ts";
import { UserError } from "./errors.ts";

export { getRulebook };

export const MAX_NAME = 40;
export const MAX_MARKDOWN = 20_000;

const NAME = /^[a-z0-9][a-z0-9_-]*$/;

function cleanName(name: string): string {
  const text = name.trim().toLowerCase();
  if (text === "") throw new UserError('A rulebook document needs a name, for example "voice". Use get_rulebook to see the names.');
  if (text.length > MAX_NAME) throw new UserError(`A rulebook name can be at most ${MAX_NAME} characters (got ${text.length}).`);
  if (!NAME.test(text)) {
    const suggestion = text.replace(/[^a-z0-9_-]+/g, "-").replace(/^[^a-z0-9]+|-+$/g, "");
    throw new UserError(
      `A rulebook name can use only letters, numbers, "-" and "_" (got "${text}")${suggestion ? `. Try "${suggestion}"` : ""}.`,
    );
  }
  return text;
}

/** Creates the document, or replaces its whole text. */
export async function updateRulebook(ctx: Ctx, name: string, markdown: string): Promise<ChangeResult> {
  const key = cleanName(name);
  if (markdown.trim() === "") {
    throw new UserError("A rulebook document's text can't be blank. Write the document, or leave it as it is.");
  }
  if (markdown.length > MAX_MARKDOWN) {
    throw new UserError(
      `A rulebook document can hold at most ${MAX_MARKDOWN.toLocaleString("en-US")} characters (got ${markdown.length}). Shorten it.`,
    );
  }
  const [before] = await getRulebook(ctx.db, key);
  if (before === undefined) {
    const row: RulebookRow = { name: key, markdown, version: 1, updated_at: ctx.now.toISOString() };
    return commitChange(ctx, {
      target: { table: "rulebook", id: key },
      summary: `Added rulebook document "${key}"`,
      changes: [{ table: "rulebook", id: key, before: null, after: row }],
    });
  }
  if (before.markdown === markdown) {
    throw new UserError(`Nothing to change: the rulebook document "${key}" already says exactly that.`);
  }
  return commitChange(ctx, {
    target: { table: "rulebook", id: key },
    summary: `Updated rulebook document "${key}"`,
    changes: [{ table: "rulebook", id: key, before, after: updatedRow(before, { markdown }, ctx.now) }],
  });
}
