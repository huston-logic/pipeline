// The Won question's answer (decision 0055): a write that marked a deal Won, while projects are on and the deal has no
// project, answers its usual line, then one "Ask the owner: ..." line per deal, and `startProject: { deal }` (an array
// when several) in the data. Without such a deal it is the plain one-line answer.
import type { CallToolResult } from "@modelcontextprotocol/server";
import type { Db } from "../db/db.ts";
import { oneLine } from "../services/change.ts";
import { startProjectOffers } from "../services/won-offers.ts";
import { toolResult, toolText } from "./format.ts";

export async function answerApplied(db: Db, summary: string, data: Record<string, unknown>, wonDeals: readonly string[]): Promise<CallToolResult> {
  const offers = await startProjectOffers(db, wonDeals);
  const [only, ...more] = offers;
  if (only === undefined) return toolResult(summary, data);
  const startProject = more.length === 0 ? { deal: only.deal } : offers.map((offer) => ({ deal: offer.deal }));
  return toolText([oneLine(summary), ...offers.map((offer) => offer.line)].join("\n"), { ...data, startProject });
}
