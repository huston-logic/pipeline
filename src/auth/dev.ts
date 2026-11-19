// Which sign-in the Worker uses (decision 0006). Without AUTH_MODE: production sign-in (Cloudflare Access for the board
// and /api, OAuth for /mcp). AUTH_MODE=dev: a fake owner is signed in, but only while the Worker runs in local
// development (`npm run dev`, `npm run preview`, the e2e tests) on a loopback host. AUTH_MODE=dev anywhere else, or any
// other AUTH_MODE value, is a misconfiguration and fails closed: the Worker answers 500 on every route.
import type { Env } from "../env.ts";

export const DEV_OWNER_EMAIL = "owner@example.test";

export type AuthMode = { kind: "dev"; email: string } | { kind: "production" } | { kind: "misconfigured"; message: string };

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

const MISCONFIGURED =
  "This server is misconfigured: AUTH_MODE=dev only works in local development on localhost, and no other " +
  "AUTH_MODE value exists. Remove the AUTH_MODE variable from this deployment.";

export function authMode(request: Request, env: Pick<Env, "ENVIRONMENT" | "AUTH_MODE">): AuthMode {
  if (env.AUTH_MODE === undefined || env.AUTH_MODE === "") return { kind: "production" };
  if (env.AUTH_MODE !== "dev" || env.ENVIRONMENT !== "development") return { kind: "misconfigured", message: MISCONFIGURED };
  if (!LOOPBACK_HOSTS.has(new URL(request.url).hostname)) return { kind: "misconfigured", message: MISCONFIGURED };
  return { kind: "dev", email: DEV_OWNER_EMAIL };
}
