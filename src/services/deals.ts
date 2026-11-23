// update_deal. The stage and the status move together: a won, lost or not_now stage sets that status, a closed
// status moves the deal to the first stage of that kind, and an open stage reopens the deal.
import type { ActivityRow, ContactRow, DealRow, DealStatus, StageRow } from "../db/db.ts";
import { getContact } from "../db/queries.ts";
import { newId } from "../ids.ts";
import { type ChangeResult, changedColumns, commitChange, type Ctx, type RowChange, updatedRow } from "./change.ts";
import { capitalize, columnLabel, fieldsLabel, joinAnd, nextPart, withArticle } from "./describe.ts";
import { UserError } from "./errors.ts";
import { checkFieldValues } from "./fields.ts";
import { checkValue, clean, whenOrNull } from "./input.ts";
import { contactName, dealLabel, dealTitle, withoutUntrusted } from "./labels.ts";
import { qualifyIfLead, withPersonStatus } from "./lead-change.ts";
import { LEAD_STATUS_LABELS } from "./lead-status.ts";
import { CLIENT, CONTACT } from "./person-move.ts";
import { clientIfWon, clientLabel } from "./person-status.ts";
import {
  type FieldValues,
  findDeal,
  findStage,
  firstStageOfKind,
  mergeFields,
  ownerTimezone,
  parseObject,
  stageLabels,
} from "./lookup.ts";

export interface DealPatch {
  /** Stage key or label. */
  stage?: string;
  status?: DealStatus;
  title?: string;
  value?: number | null;
  nextStep?: string | null;
  nextAt?: string | null;
  /** Merged into the stored values; null removes a key. */
  fields?: FieldValues;
}

const STATUS_WORDS: Record<DealStatus, string> = { open: "open", won: "won", lost: "lost", not_now: "not now" };

async function targetStage(ctx: Ctx, deal: DealRow, patch: DealPatch): Promise<StageRow | null> {
  const { db } = ctx;
  if (patch.stage !== undefined) {
    const stage = await findStage(db, patch.stage);
    if (patch.status !== undefined && patch.status !== stage.kind) {
      throw new UserError(
        `${stage.label} is ${withArticle(STATUS_WORDS[stage.kind])} stage, ` +
          `so the status can't be ${STATUS_WORDS[patch.status]}. Give just the stage; the status follows it.`,
      );
    }
    return stage;
  }
  if (patch.status === undefined || patch.status === deal.status) return null;
  if (patch.status === "open") {
    const first = await firstStageOfKind(db, "open");
    const example = first ? ` (for example ${first.key})` : "";
    throw new UserError(
      `Say which open stage to move ${dealTitle(deal)} back to${example}; the status follows the stage.`,
    );
  }
  const stage = await firstStageOfKind(db, patch.status);
  if (!stage) {
    throw new UserError(`There's no ${STATUS_WORDS[patch.status]} stage to move it to. Add one with add_stage first.`);
  }
  return stage;
}

export async function updateDeal(ctx: Ctx, dealRef: string, patch: DealPatch): Promise<ChangeResult & { dealId: string }> {
  const { db } = ctx;
  const before = await findDeal(db, dealRef);
  const tz = await ownerTimezone(db);
  const contact = await getContact(db, before.contact_id);
  if (!contact) throw new Error(`Deal ${before.id} points at a missing contact.`);
  // An archived deal (often one moved back to leads) stays as it is; reopening it would hide an open deal.
  if (before.archived === 1) {
    throw new UserError(`${capitalize(dealLabel(before, contact))} is archived. Undo the change that archived it to bring it back.`);
  }
  const now = ctx.now.toISOString();
  const set: Partial<DealRow> = {};

  const stage = await targetStage(ctx, before, patch);
  const moved = stage !== null && stage.key !== before.stage_key;
  if (stage !== null) {
    set.status = stage.kind;
    if (moved) {
      set.stage_key = stage.key;
      set.stage_entered_at = now;
    }
  }
  if (patch.title !== undefined) {
    const title = clean(patch.title);
    if (title === null) throw new UserError("A deal's title can't be blank. Give the new title.");
    set.title = title;
    // The owner or the AI set it, so it is no longer outside text.
    set.untrusted_fields = withoutUntrusted(before, ["title"]);
  }
  if (patch.value !== undefined) set.value = patch.value === null ? null : checkValue(patch.value);
  if (patch.nextStep !== undefined) set.next_step = clean(patch.nextStep);
  if (patch.nextAt !== undefined) set.next_at = whenOrNull(patch.nextAt, tz);
  if (patch.fields !== undefined) {
    await checkFieldValues(db, "deal", patch.fields);
    set.fields = mergeFields(before.fields, patch.fields);
  }

  const after = updatedRow(before, set, ctx.now);
  const changed = changedColumns(before, after).filter((c) => c !== "version" && c !== "updated_at");
  if (changed.length === 0) {
    throw new UserError(`Nothing to change on ${dealTitle(before)}: every value you gave is already set.`);
  }

  const changes: RowChange[] = [{ table: "deals", id: before.id, before, after }];
  // Reopening a closed deal, or marking a Lost or Not now deal Won, makes it a real opportunity again, so a lead
  // among its people is Qualified (invariant 1, decisions 0022 and 0040).
  const wasClosed = before.status !== "open" && before.status !== "won";
  const realAgain = (before.status !== "open" && after.status === "open") || (wasClosed && after.status === "won");
  const qualified = realAgain ? qualifyIfLead(contact, ctx.now) : null;
  // A deal marked Won makes a Contact a Client in the same change, so undo puts both back (decision 0040). A lead
  // Qualified by this same change is a Contact by then, so they become a Client too, in one move of their row.
  const markedWon = before.status !== "won" && after.status === "won";
  const asContact = qualified === null ? contact : (qualified.after as ContactRow);
  const client = markedWon ? await clientIfWon(db, asContact, ctx.now) : null;
  if (client !== null && qualified !== null) {
    changes.push({ ...qualified, after: withPersonStatus(contact, { status: CONTACT, sub: CLIENT }, ctx.now) });
  } else if (client !== null) {
    changes.push(client);
  } else if (qualified !== null) {
    changes.push(qualified);
  }
  const labels = await stageLabels(db);
  if (moved) {
    const activity: ActivityRow = {
      id: newId("ac"),
      deal_id: before.id,
      contact_id: before.contact_id,
      type: "stage_change",
      summary: `Moved from ${labels.get(before.stage_key) ?? before.stage_key} to ${stage.label}.`,
      untrusted_text: null,
      data: JSON.stringify({ from: before.stage_key, to: stage.key }),
      occurred_at: now,
      actor: ctx.actor,
      version: 1,
      created_at: now,
    };
    changes.push({ table: "activities", id: activity.id, before: null, after: activity });
  }

  const who = dealLabel(after, contact);
  const parts: string[] = [];
  if (changed.includes("next_step") || changed.includes("next_at")) {
    parts.push(nextPart(after.next_step, after.next_at, tz).replace(/^; /, "") || "next step cleared");
  }
  const others = changed
    .filter((c) => ["title", "value", "fields"].includes(c))
    .map((c) => (c === "fields" ? fieldsLabel(parseObject(before.fields), parseObject(after.fields)) : columnLabel(c)));
  if (others.length > 0) parts.push(`changed ${joinAnd(others)}`);
  const clientWord = client === null ? null : withArticle(await clientLabel(db));
  if (qualified !== null) {
    parts.push(`${contactName(contact)} is now ${LEAD_STATUS_LABELS.qualified}${clientWord === null ? "" : ` and ${clientWord}`}`);
  } else if (clientWord !== null) {
    parts.push(`${contactName(contact)} is now ${clientWord}`);
  }
  const summary = moved
    ? [`Moved ${who} to ${stage.label}`, ...parts].join("; ")
    : `Updated ${who}: ${parts.join("; ") || (changed.includes("untrusted_fields") ? "confirmed the title" : `set the status to ${STATUS_WORDS[after.status]}`)}`;

  const result = await commitChange(ctx, { target: { table: "deals", id: before.id }, summary, changes });
  return { ...result, dealId: before.id };
}
