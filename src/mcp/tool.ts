// Registers one pipeline tool on an SDK v2 McpServer. The zod schema is advertised to clients as JSON Schema, but
// the arguments are checked here rather than by the SDK, so a bad request gets a plain-English answer naming the field
// (format.ts) instead of the SDK's "Input validation error: ..." text.
import type { CallToolResult, McpServer, StandardSchemaWithJSON, ToolAnnotations } from "@modelcontextprotocol/server";
import type { z } from "zod";
import type { Db } from "../db/db.ts";
import { inputErrorMessage, toolError } from "./format.ts";

export interface ToolDeps {
  db: Db;
  now: () => Date;
  /** The OWNER_EMAILS var ("a@example.com, b@example.com"): owner emails on top of settings.owner_emails. */
  ownerEmailsVar?: string;
}

export type ToolKind = "read" | "write";

export interface ToolDef<S extends z.ZodObject> {
  name: string;
  title: string;
  description: string;
  input: S;
  kind: ToolKind;
  /**
   * Write tools only: true when the tool overwrites values, closes or archives something, or removes records (undo of
   * an add does). Undo exists, but clients use the hint to ask the owner before calling.
   */
  destructive?: boolean;
  /** Write tools only: true when repeating the same call changes nothing more. */
  idempotent?: boolean;
  run(args: z.output<S>, deps: ToolDeps): Promise<CallToolResult>;
}

export function annotationsFor(def: Pick<ToolDef<z.ZodObject>, "title" | "kind" | "destructive" | "idempotent">): ToolAnnotations {
  if (def.kind === "read") return { title: def.title, readOnlyHint: true, openWorldHint: false };
  return {
    title: def.title,
    readOnlyHint: false,
    destructiveHint: def.destructive ?? false,
    idempotentHint: def.idempotent ?? false,
    openWorldHint: false,
  };
}

type JsonSchemaConverter = StandardSchemaWithJSON<unknown, unknown>["~standard"]["jsonSchema"];
type JsonSchemaOptions = Parameters<JsonSchemaConverter["input"]>[0];

/**
 * JSON Schemas already worked out, by tool name, side and target. Every request builds its server and tools again
 * (decision 0004), but a tool's schema is the same code every time, so converting it once per isolate is enough: it
 * was about 40% of a tools/list request's CPU (docs/PAID-PLAN.md, CPU check). Tool names are unique per server. Each
 * schema is frozen, all the way down, so no request can change what a later one is sent.
 */
const converted = new Map<string, Record<string, unknown>>();

function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

function cachedConverter(name: string, jsonSchema: JsonSchemaConverter): JsonSchemaConverter {
  const once = (side: "input" | "output") => (options: JsonSchemaOptions) => {
    const key = `${name}\u0000${side}\u0000${options.target}`;
    let schema = converted.get(key);
    if (schema === undefined) {
      schema = deepFreeze(jsonSchema[side](options));
      converted.set(key, schema);
    }
    return schema;
  };
  return { input: once("input"), output: once("output") };
}

/** The schema's JSON Schema for tools/list, with a validator that lets every value through to `registerTool` below. */
export function advertised(name: string, schema: z.ZodObject): StandardSchemaWithJSON<unknown, unknown> {
  return {
    "~standard": {
      version: 1,
      vendor: "pipeline",
      validate: (value: unknown) => ({ value }),
      jsonSchema: cachedConverter(name, schema["~standard"].jsonSchema),
    },
  };
}

export function registerTool<S extends z.ZodObject>(server: McpServer, def: ToolDef<S>, deps: ToolDeps): void {
  server.registerTool(
    def.name,
    {
      title: def.title,
      description: def.description,
      inputSchema: advertised(def.name, def.input),
      annotations: annotationsFor(def),
    },
    async (args: unknown): Promise<CallToolResult> => {
      const parsed = def.input.safeParse(args ?? {});
      if (!parsed.success) {
        return { content: [{ type: "text", text: inputErrorMessage(def.name, def.input, parsed.error.issues, args) }], isError: true };
      }
      try {
        return await def.run(parsed.data, deps);
      } catch (error) {
        return toolError(error, def.name);
      }
    },
  );
}
