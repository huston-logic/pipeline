// Production sign-in for the board and /api (decision 0006): Cloudflare Access signs the owner in (a self-hosted
// application with One-time PIN) and the Worker checks its token and that the email is an owner's.
import type { Env } from "../env.ts";
import { accessIssuer, accessToken, JwtError, verifyAccessJwt } from "./access-jwt.ts";
import type { JwksFetcher } from "./jwt.ts";
import { ownerEmails } from "./owners.ts";

export type AccessResult = { ok: true; email: string } | { ok: false; status: 401 | 403 | 500 | 503; message: string };

export const SIGN_IN_NOT_SET_UP = "Sign-in isn't set up yet.";
const SIGN_IN_REQUIRED = "Sign in through Cloudflare Access to open the board.";
const NOT_AN_OWNER = "This account isn't allowed to open this board.";
const KEYS_UNAVAILABLE = "Sign-in couldn't be checked just now. Try again in a minute.";

export interface AccessDeps {
  fetchJwks?: JwksFetcher;
  now?: () => number;
}

export async function accessSignIn(request: Request, env: Env, deps: AccessDeps = {}): Promise<AccessResult> {
  const teamDomain = env.ACCESS_TEAM_DOMAIN ?? "";
  const aud = (env.ACCESS_AUD ?? "").trim();
  if (!accessIssuer(teamDomain) || aud === "") return { ok: false, status: 500, message: SIGN_IN_NOT_SET_UP };
  const owners = await ownerEmails(env.DB, env);
  if (owners.size === 0) return { ok: false, status: 500, message: SIGN_IN_NOT_SET_UP };

  const token = accessToken(request);
  if (!token) return { ok: false, status: 401, message: SIGN_IN_REQUIRED };
  let email: string;
  try {
    ({ email } = await verifyAccessJwt(token, { teamDomain, aud, ...deps }));
  } catch (error) {
    if (error instanceof JwtError) return { ok: false, status: 401, message: SIGN_IN_REQUIRED };
    console.error(JSON.stringify({ event: "access_keys_unavailable" }));
    return { ok: false, status: 503, message: KEYS_UNAVAILABLE };
  }
  if (!owners.has(email)) return { ok: false, status: 403, message: NOT_AN_OWNER };
  return { ok: true, email };
}
