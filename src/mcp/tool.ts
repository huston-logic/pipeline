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
}

export type ToolKind = "read" | "write";

export interface ToolDef<S extends z.ZodObject> {
  name: string;
  title: string;
  description: string;
  input: S;
  kind: ToolKind;
  /** Write tools only: true when the tool can remove records (undo of an add does). */
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

/** The schema's JSON Schema for tools/list, with a validator that lets every value through to `registerTool` below. */
function advertised(schema: z.ZodObject): StandardSchemaWithJSON<unknown, unknown> {
  return {
    "~standard": {
      version: 1,
      vendor: "pipeline",
      validate: (value: unknown) => ({ value }),
      jsonSchema: schema["~standard"].jsonSchema,
    },
  };
}

export function registerTool<S extends z.ZodObject>(server: McpServer, def: ToolDef<S>, deps: ToolDeps): void {
  server.registerTool(
    def.name,
    {
      title: def.title,
      description: def.description,
      inputSchema: advertised(def.input),
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
