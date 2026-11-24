// How every tool answers: one plain-English headline line, a blank line, then the data as pretty JSON. Headlines
// are built from counts, ids and owner-set labels, or are a write's own summary line; text from outside stays inside
// the JSON, where `untrusted_text` and `untrusted_fields` label it.
import type { CallToolResult } from "@modelcontextprotocol/server";
import { oneLine } from "../services/change.ts";
import { UserError } from "../services/errors.ts";

export { inputErrorMessage } from "../services/input-errors.ts";

export const GENERIC_ERROR = "Something went wrong on the server. Nothing was changed.";

export function toolResult(text: string, data?: unknown): CallToolResult {
  const headline = oneLine(text);
  const body = data === undefined ? headline : `${headline}\n\n${JSON.stringify(data, null, 2)}`;
  return { content: [{ type: "text", text: body }] };
}

/**
 * An answer whose text is several lines (a proposal's list, decision 0044): the lines as written, a blank line, then
 * the data as pretty JSON, which has no blank line in it, so the data starts after the last blank line.
 */
export function toolText(text: string, data: unknown): CallToolResult {
  const lines = text.split("\n").map((line) => line.replace(/\s+/g, " ").trimEnd());
  return { content: [{ type: "text", text: `${lines.join("\n")}\n\n${JSON.stringify(data, null, 2)}` }] };
}

function errorResult(text: string): CallToolResult {
  return { content: [{ type: "text", text }], isError: true };
}

/** A UserError's message as is; anything else becomes the generic message, logged as a fixed event name. */
export function toolError(error: unknown, tool = "unknown"): CallToolResult {
  if (error instanceof UserError) return errorResult(error.message);
  console.error(JSON.stringify({ event: "mcp_tool_failed", tool }));
  return errorResult(GENERIC_ERROR);
}
