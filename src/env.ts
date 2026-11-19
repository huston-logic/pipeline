// The Worker's bindings, vars and secrets (docs/SECRETS.md lists each one and where it is set).
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
  /**
   * Unset: production sign-in (Cloudflare Access; decision 0006). "dev" only in local development (scripts/dev.mjs);
   * anywhere else, or any other value, the Worker refuses every request.
   */
  AUTH_MODE?: string;
  /** The Zero Trust team domain, for example "example-team.cloudflareaccess.com" (a per-copy var). */
  ACCESS_TEAM_DOMAIN?: string;
  /** The Application Audience (AUD) tag of the board's self-hosted Access application (a per-copy var). */
  ACCESS_AUD?: string;
  /** Comma-separated owner emails allowed in, on top of settings.owner_emails (a per-copy var). */
  OWNER_EMAILS?: string;
  /** OAuth state for /mcp: clients, grants, hashed tokens, sign-in state (KV binding; workers-oauth-provider). */
  OAUTH_KV?: KVNamespace;
  /** The Access for SaaS (OIDC) application's client ID, client secret and endpoints (secrets). */
  ACCESS_CLIENT_ID?: string;
  ACCESS_CLIENT_SECRET?: string;
  ACCESS_TOKEN_URL?: string;
  ACCESS_AUTHORIZATION_URL?: string;
  ACCESS_JWKS_URL?: string;
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
