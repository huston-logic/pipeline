// The "AI edits" switch (decision 0045). Every record write tool (the RECORD_ACTIONS tools) runs through recordWrite:
// under Review first, and for anything but a small change under Apply small changes, it proposes the one action exactly
// as propose_changes would and answers the same way, so nothing changes until the owner's yes reaches apply_changes.
// A small change under Apply small changes is written at once, as one audited change (actor ai, the tool's name), and
// answers the service's summary line. While the owner approves on the board only (decision 0061) nothing is small:
// every action is proposed, whatever "AI edits" says. Settings, rules, stages, fields, statuses, views, the rulebook, imports and
// undo_change don't come here: they write at once as before.
import type { CallToolResult } from "@modelcontextprotocol/server";
import { parseOwnerEmailsVar } from "../auth/owners.ts";
import { UserError } from "../services/errors.ts";
import { type ActionResult, type RecordAction, runAction } from "../services/proposal-actions.ts";
import { proposeChanges } from "../services/proposals.ts";
import { smallChangesApplyAtOnce } from "../services/settings.ts";
import { answerApplied } from "./start-project.ts";
import { aiCtx, type ToolDeps } from "./tool.ts";
import { proposeResult } from "./tools-proposals.ts";

/** A record named by "@n" is one a list adds, never an existing one. */
const existing = (ref: string | undefined) => ref === undefined || !ref.trim().startsWith("@");

/**
 * true when the action may apply at once under "Apply small changes": a call or a note logged on an existing person or
 * deal, completing a task, starting a timer, or stopping one without a next step (decision 0049). Everything else is
 * proposed under both settings.
 */
export function isSmallAction(action: RecordAction): boolean {
  if (action.action === "complete_task") return action.subTasks !== "complete";
  if (action.action === "start_timer") return existing(action.deal) && existing(action.contact) && existing(action.task) && existing(action.project);
  if (action.action === "stop_timer") return action.nextStepDate === undefined;
  if (action.action !== "log_activity") return false;
  return (action.type === "call" || action.type === "note") && existing(action.deal) && existing(action.contact) && existing(action.project);
}

/** The ids each record tool has always answered beside its change id, when the action made them. */
const ANSWER_IDS = ["contactId", "dealId", "activityId", "taskId", "entryId", "projectId", "matchedExisting"] as const;

function answerData(result: ActionResult): Record<string, unknown> {
  const data: Record<string, unknown> = { changeId: result.changeId };
  for (const key of ANSWER_IDS) if (result[key] !== undefined) data[key] = result[key];
  return data;
}

/**
 * A one-action proposal's refusal is the service's own message: "Action 1: " says nothing when the owner asked for one
 * thing. Any other refusal (a list rule, a race) is kept as it is.
 */
function ownMessage(error: unknown): unknown {
  if (error instanceof UserError && error.message.startsWith("Action 1: ") && error.cause instanceof UserError) return error.cause;
  return error;
}

/** Every record write tool's run(): propose (review, or not small) or apply at once, one shape of answer. */
export async function recordWrite(deps: ToolDeps, action: RecordAction): Promise<CallToolResult> {
  const ctx = aiCtx(deps, action.action);
  const options = { extraOwnerEmails: parseOwnerEmailsVar(deps.ownerEmailsVar) };
  if (isSmallAction(action) && (await smallChangesApplyAtOnce(deps.db))) {
    const result = await runAction(ctx, action, options);
    // No small action can mark a deal Won, so there is no Won question to ask here.
    return answerApplied(deps.db, result.summary, answerData(result), []);
  }
  try {
    return proposeResult(await proposeChanges(ctx, { actions: [action] }, options), deps.origin);
  } catch (error) {
    throw ownMessage(error);
  }
}
