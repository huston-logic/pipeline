// Test helpers: an MCP SDK v2 Client wired to a server, in memory or over HTTP, and readers for tool answers.
import assert from "node:assert/strict";
import { Client, InMemoryTransport, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import type { McpServer } from "@modelcontextprotocol/server";

export type ToolAnswer = { isError: boolean; text: string; headline: string; data: unknown };

export async function connectInMemory(server: McpServer): Promise<Client> {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: "pipeline-tests", version: "1.0.0" });
  await client.connect(clientSide);
  return client;
}

export async function connectHttp(url: string): Promise<Client> {
  const client = new Client({ name: "pipeline-e2e", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(url)));
  return client;
}

/**
 * Calls a tool and splits its one text block into the headline and the JSON data below it. The data starts after the
 * last blank line (pretty JSON has none), so a several-line answer such as a proposal's list keeps all its lines.
 */
export async function call(client: Client, name: string, args: Record<string, unknown> = {}): Promise<ToolAnswer> {
  const result = await client.callTool({ name, arguments: args });
  const content = result.content as { type: string; text?: string }[];
  assert.equal(content.length, 1, `${name} answers with one content block`);
  assert.equal(content[0]?.type, "text");
  const text = content[0]?.text ?? "";
  const split = text.lastIndexOf("\n\n");
  const headline = split === -1 ? text : text.slice(0, split);
  const data: unknown = split === -1 ? undefined : JSON.parse(text.slice(split + 2));
  return { isError: result.isError === true, text, headline, data };
}

/** Calls a tool that must succeed. */
export async function ok(client: Client, name: string, args: Record<string, unknown> = {}): Promise<ToolAnswer> {
  const answer = await call(client, name, args);
  assert.equal(answer.isError, false, `${name} failed: ${answer.text}`);
  assert.doesNotMatch(answer.headline, /\n/, `${name}'s headline is one line`);
  return answer;
}

/** Calls a tool that must succeed and answers several lines (propose_changes): its text is `headline`. */
export async function okText(client: Client, name: string, args: Record<string, unknown> = {}): Promise<ToolAnswer> {
  const answer = await call(client, name, args);
  assert.equal(answer.isError, false, `${name} failed: ${answer.text}`);
  return answer;
}

/** Calls a tool that must fail with a plain-English message. */
export async function fails(client: Client, name: string, args: Record<string, unknown> = {}): Promise<string> {
  const answer = await call(client, name, args);
  assert.equal(answer.isError, true, `${name} should have failed: ${answer.text}`);
  return answer.text;
}

export const CHANGE_LINE = /\(change chg_[a-z0-9]{12}\)$/;

type ListItem = { id: string };
type ProposedList = { add: ListItem[]; update: ListItem[]; tasks: ListItem[]; notes: ListItem[] };

/** The first id with the prefix among the groups, in order. */
const idIn = (groups: readonly ListItem[][], prefix: string) => groups.flat().find((item) => item.id.startsWith(prefix))?.id;

/**
 * A record tool call the owner says "Yes" to (decision 0045): the tool must answer a proposal, and apply_changes
 * writes it. Answers apply_changes' answer with `headline` the action's own summary line (the "Applied pr_…: " in
 * front taken off; it still ends with "(change chg_...)"), and `data` the change id plus the ids of the records the
 * list shows (contactId, dealId, taskId, activityId), so a test reads the same line and ids the tool once answered.
 */
export async function approved(
  client: Client,
  name: string,
  args: Record<string, unknown> = {},
): Promise<ToolAnswer & { proposal: string; proposed: ToolAnswer }> {
  const proposed = await okText(client, name, args);
  const { proposal, list } = (proposed.data ?? {}) as { proposal?: string; list?: ProposedList };
  assert.ok(typeof proposal === "string" && list !== undefined, `${name} answers a proposal: ${proposed.text}`);
  const applied = await ok(client, "apply_changes", { proposal });
  const front = `Applied ${proposal}: `;
  assert.ok(applied.headline.startsWith(front), applied.headline);
  const ids: Record<string, string> = {};
  for (const [key, groups, prefix] of [
    ["contactId", [list.add, list.update], "ct_"],
    ["dealId", [list.add, list.update], "dl_"],
    ["projectId", [list.add, list.update], "pj_"],
    ["taskId", [list.tasks], "tk_"],
    ["activityId", [list.notes], "ac_"],
  ] as const) {
    const id = idIn(groups, prefix);
    if (id !== undefined) ids[key] = id;
  }
  const { changeId } = applied.data as { changeId: string };
  return { ...applied, headline: applied.headline.slice(front.length), data: { changeId, ...ids }, proposal, proposed };
}
