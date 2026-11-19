// The Worker's bindings, vars and secrets. Later tasks add rate limits, OAuth KV and secrets here.
import type { Db } from "./db/db.ts";

/** The part of the static-assets binding the Worker uses, so tests can pass a plain object. */
export type AssetFetcher = { fetch(request: Request): Promise<Response> };

/** The part of Cloudflare's Rate Limiting binding the Worker uses. */
export type RateLimiter = { limit(options: { key: string }): Promise<{ success: boolean }> };

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
  /** "on" lets the daily brief be emailed; anything else, or unset, keeps sending off (decision 0011). */
  BRIEF_SENDING?: string;
  /** The "from" address for the brief email, on a domain verified in Resend. */
  BRIEF_FROM?: string;
  /** Resend API key (a secret: set with `wrangler secret put`, never in the repo). */
  RESEND_API_KEY?: string;
  /** The shared secret a website form's server sends in X-Intake-Secret (a secret). Unset: /intake answers 503. */
  INTAKE_SECRET?: string;
  /** Rate limit for /intake by client IP (binding in wrangler.jsonc). Absent: requests are allowed and a log line says so. */
  INTAKE_RATE_LIMIT?: RateLimiter;
};
