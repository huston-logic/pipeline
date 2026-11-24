// Schema failures in plain English (inputErrorMessage): each field named, with the shape it needs. The MCP tools
// (src/mcp/tool.ts, through src/mcp/format.ts) and a proposal's actions (proposal-actions.ts) both use it.
import type { z } from "zod";

type Issue = z.core.$ZodIssue;
type ObjectSchema = z.ZodObject;

const SHAPES: Record<string, string> = {
  string: "text",
  number: "a number",
  int: "a whole number",
  boolean: "true or false",
  null: "null",
  object: "an object",
  record: "an object",
  array: "a list",
};

const shapeOf = (expected: string) => SHAPES[expected] ?? expected;

/** "a", "a or b", "a, b, or c". */
function joinOr(items: string[]): string {
  if (items.length <= 2) return items.join(" or ");
  return `${items.slice(0, -1).join(", ")}, or ${items.at(-1)}`;
}

function valueAt(args: unknown, path: PropertyKey[]): unknown {
  let value = args;
  for (const key of path) {
    if (typeof value !== "object" || value === null) return undefined;
    value = (value as Record<PropertyKey, unknown>)[key];
  }
  return value;
}

function unionShapes(issue: Extract<Issue, { code: "invalid_union" }>): string[] {
  const shapes = issue.errors.flatMap((branch) =>
    branch.flatMap((inner) => (inner.code === "invalid_type" ? [shapeOf(inner.expected)] : [])),
  );
  return [...new Set(shapes)];
}

/** A description set on the schema or on the schema an optional() or nullable() wraps. */
function descriptionOf(schema: z.core.$ZodType | undefined): string | undefined {
  let current = schema;
  while (current) {
    const description = (current as z.ZodType).description;
    if (description) return description;
    const def = current._zod.def as { innerType?: z.core.$ZodType };
    current = def.innerType;
  }
  return undefined;
}

/** A top-level field that is nullable() takes null as well as its own shape. */
function orNullFor(schema: ObjectSchema, path: PropertyKey[]): string {
  const [top] = path;
  if (path.length !== 1 || typeof top !== "string") return "";
  let current: z.core.$ZodType | undefined = schema.shape[top];
  while (current) {
    const def = current._zod.def as { type: string; innerType?: z.core.$ZodType };
    if (def.type === "nullable") return " or null";
    current = def.innerType;
  }
  return "";
}

/** The field's description, lowercased to sit inside a sentence: "(the person's full name)". */
function aboutField(schema: ObjectSchema, path: PropertyKey[]): string {
  const [top] = path;
  if (typeof top !== "string") return "";
  const description = descriptionOf(schema.shape[top])?.trim().replace(/\.$/, "");
  if (!description) return "";
  const lowered = /^[A-Z][a-z]/.test(description) ? description[0]?.toLowerCase() + description.slice(1) : description;
  return ` (${lowered})`;
}

function describeIssue(schema: ObjectSchema, issue: Issue, args: unknown): string {
  const path = issue.path.map(String).join(".");
  const field = path ? `"${path}"` : "The input";
  const about = aboutField(schema, issue.path);
  switch (issue.code) {
    case "invalid_type":
      return valueAt(args, issue.path) === undefined
        ? `${field} is missing; it needs ${shapeOf(issue.expected)}${about}.`
        : `${field} must be ${shapeOf(issue.expected)}${orNullFor(schema, issue.path)}${about}.`;
    case "unrecognized_keys": {
      const names = issue.keys.map((key) => `"${key}"`).join(", ");
      const where = path ? ` in ${field}` : "";
      const keys = Object.keys(schema.shape);
      const known = path ? "" : keys.length > 0 ? ` Use only: ${keys.join(", ")}.` : " This tool takes no arguments.";
      return `Unknown field${issue.keys.length === 1 ? "" : "s"} ${names}${where}.${known}`;
    }
    case "invalid_value":
      return `${field} must be one of: ${issue.values.map(String).join(", ")}${about}.`;
    case "too_small":
      if (issue.origin === "string") return `${field} can't be empty${about}.`;
      if (issue.origin === "array") return `${field} needs at least ${issue.minimum} item(s)${about}.`;
      return `${field} must be at least ${issue.minimum}${about}.`;
    case "too_big":
      if (issue.origin === "string") return `${field} is too long: keep it to ${issue.maximum} characters or fewer.`;
      if (issue.origin === "array") return `${field} has too many items: at most ${issue.maximum}.`;
      return `${field} must be at most ${issue.maximum}${about}.`;
    case "invalid_union": {
      // A discriminated union (a proposal's actions) names the values its key takes.
      const options = (issue as { options?: unknown }).options;
      if (Array.isArray(options) && options.length > 0) return `${field} must be one of: ${options.map(String).join(", ")}.`;
      const shapes = unionShapes(issue);
      return shapes.length > 0 ? `${field} must be ${joinOr(shapes)}${about}.` : `${field} has the wrong shape${about}.`;
    }
    case "invalid_format":
      return `${field} isn't in the right format${about}.`;
    default:
      return `${field} has the wrong shape${about}.`;
  }
}

/** Schema failures in plain English: each field named, with the shape it needs. */
export function inputErrorMessage(tool: string, schema: ObjectSchema, issues: readonly Issue[], args: unknown): string {
  const sentences = [...new Set(issues.map((issue) => describeIssue(schema, issue, args)))];
  return `Fix the ${tool} request: ${sentences.join(" ")}`;
}
