import assert from "node:assert/strict";
import { test } from "node:test";
import { z } from "zod";
import { UserError } from "../services/errors.ts";
import { GENERIC_ERROR, inputErrorMessage, toolError, toolResult } from "./format.ts";

const textOf = (result: { content: { type: string; text?: string }[] }) => {
  const [first] = result.content;
  assert.equal(first?.type, "text");
  return first?.text ?? "";
};

test("toolResult is a headline, a blank line, then pretty JSON of the data", () => {
  const result = toolResult("2 open deals.", { deals: [{ id: "dl_1" }] });
  assert.equal(result.isError, undefined);
  assert.equal(result.content.length, 1);
  assert.equal(textOf(result), `2 open deals.\n\n${JSON.stringify({ deals: [{ id: "dl_1" }] }, null, 2)}`);
});

test("toolResult without data is just the headline, kept on one line", () => {
  assert.equal(textOf(toolResult("Done.")), "Done.");
  assert.equal(textOf(toolResult("Two\nlines  here.")), "Two lines here.");
});

test("toolError shows a UserError's message as an error result", () => {
  const result = toolError(new UserError("No deal matches \"x\". Use list_deals to find the deal's id."));
  assert.equal(result.isError, true);
  assert.equal(textOf(result), "No deal matches \"x\". Use list_deals to find the deal's id.");
});

test("toolError hides anything else and logs only a fixed event name", (t) => {
  const logged = t.mock.method(console, "error", () => {});
  const result = toolError(new Error("D1_ERROR: secret details about pat@example.com"), "add_lead");
  assert.equal(result.isError, true);
  assert.equal(textOf(result), GENERIC_ERROR);
  assert.equal(GENERIC_ERROR, "Something went wrong on the server. Nothing was changed.");
  assert.equal(logged.mock.callCount(), 1);
  const line = JSON.stringify(logged.mock.calls[0]?.arguments);
  assert.match(line, /mcp_tool_failed/);
  assert.match(line, /add_lead/);
  assert.doesNotMatch(line, /secret|pat@example\.com|D1_ERROR/);
});

const schema = z.strictObject({
  name: z.string().min(1).describe("The person's full name."),
  value: z.number().optional().describe("Deal value."),
  type: z.enum(["call", "email"]).optional(),
  quiet: z.number().int().min(1).optional(),
  fields: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])).optional(),
  email: z.string().describe("Their email address.").nullable().optional(),
});

function issuesFor(args: Record<string, unknown>) {
  const parsed = schema.safeParse(args);
  assert.equal(parsed.success, false);
  return inputErrorMessage("add_lead", schema, parsed.error?.issues ?? [], args);
}

test("a missing field is named, with the shape it needs and its description", () => {
  const message = issuesFor({});
  assert.match(message, /"name" is missing/);
  assert.match(message, /text/);
  assert.match(message, /the person.s full name/);
  assert.match(message, /add_lead/);
  assert.doesNotMatch(message, /Invalid input|expected string|received/);
});

test("a wrong type, an unknown field, a bad choice and a too-small number each read as plain English", () => {
  assert.match(issuesFor({ name: "Pat", value: "lots" }), /"value" must be a number/);
  assert.match(issuesFor({ name: "Pat", nextAt: "x" }), /Unknown field "nextAt".*Use only: name, value, type, quiet, fields, email/);
  assert.match(issuesFor({ name: "Pat", type: "fax" }), /"type" must be one of: call, email/);
  assert.match(issuesFor({ name: "Pat", quiet: 0 }), /"quiet" must be at least 1/);
  assert.match(issuesFor({ name: "Pat", quiet: 1.5 }), /"quiet" must be a whole number/);
  assert.match(issuesFor({ name: "" }), /"name" can't be empty/);
  assert.match(issuesFor({ name: "Pat", email: 5 }), /"email" must be text or null \(their email address\)/);
  assert.match(issuesFor({ name: "Pat", fields: { budget: [1] } }), /"fields\.budget" must be text, a number, true or false, or null/);
});
