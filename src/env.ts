// The Worker's bindings, vars and secrets. Later tasks add rate limits, OAuth KV and secrets here.
import type { Db } from "./db/db.ts";

/** The part of the static-assets binding the Worker uses, so tests can pass a plain object. */
export type AssetFetcher = { fetch(request: Request): Promise<Response> };

export type Env = {
  ASSETS: AssetFetcher;
  /** The D1 database (binding "DB" in wrangler.jsonc). Typed as the part the code uses, so tests can pass the shim. */
  DB: Db;
  /** "production" from wrangler.jsonc; `npm run dev` and `npm run preview` set "development". */
  ENVIRONMENT: string;
  /** "dev" only in local development (scripts/dev.mjs). Anywhere else the Worker refuses every request. */
  AUTH_MODE?: string;
  /**
   * Comma-separated hostnames /mcp answers on, for a copy on a custom domain (for example "pipeline.example.com").
   * Unset, localhost and *.workers.dev hosts are checked and other hosts rely on Cloudflare routing (decision 0004).
   */
  MCP_ALLOWED_HOSTNAMES?: string;
};
