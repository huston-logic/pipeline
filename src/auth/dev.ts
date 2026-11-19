// Local-development sign-in for /mcp: AUTH_MODE=dev signs in a fake owner, but only while the Worker runs in local
// development (`npm run dev`, `npm run preview`, the e2e tests) and only for a loopback host. AUTH_MODE=dev anywhere
// else is a misconfiguration and fails closed: the Worker answers 500 on every route. Without AUTH_MODE, /mcp answers
// 401 until production OAuth exists (plan task 10).
import type { Env } from "../env.ts";

export const DEV_OWNER_EMAIL = "owner@example.test";

export type AuthResult = { ok: true; email: string } | { ok: false; status: 401 | 500; message: string };

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

const MISCONFIGURED =
  "This server is misconfigured: AUTH_MODE=dev only works in local development on localhost. " +
  "Remove the AUTH_MODE variable from this deployment.";

const NO_SIGN_IN =
  "Sign-in for /mcp isn't set up on this server yet, so it can't be used. " +
  "For local development, run `npm run dev` (it turns on the local dev sign-in).";

export function devAuth(request: Request, env: Pick<Env, "ENVIRONMENT" | "AUTH_MODE">): AuthResult {
  if (env.AUTH_MODE === undefined || env.AUTH_MODE === "") return { ok: false, status: 401, message: NO_SIGN_IN };
  if (env.AUTH_MODE !== "dev" || env.ENVIRONMENT !== "development") {
    return { ok: false, status: 500, message: MISCONFIGURED };
  }
  if (!LOOPBACK_HOSTS.has(new URL(request.url).hostname)) return { ok: false, status: 500, message: MISCONFIGURED };
  return { ok: true, email: DEV_OWNER_EMAIL };
}
