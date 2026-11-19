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

/** Calls a tool and splits its one text block into the headline and the JSON data below it. */
export async function call(client: Client, name: string, args: Record<string, unknown> = {}): Promise<ToolAnswer> {
  const result = await client.callTool({ name, arguments: args });
  const content = result.content as { type: string; text?: string }[];
  assert.equal(content.length, 1, `${name} answers with one content block`);
  assert.equal(content[0]?.type, "text");
  const text = content[0]?.text ?? "";
  const split = text.indexOf("\n\n");
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

/** Calls a tool that must fail with a plain-English message. */
export async function fails(client: Client, name: string, args: Record<string, unknown> = {}): Promise<string> {
  const answer = await call(client, name, args);
  assert.equal(answer.isError, true, `${name} should have failed: ${answer.text}`);
  return answer.text;
}

export const CHANGE_LINE = /\(change chg_[a-z0-9]{12}\)$/;
