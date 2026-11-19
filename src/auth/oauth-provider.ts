// Production /mcp sign-in (decision 0006): one Worker is both the OAuth authorization server and its only resource,
// through workers-oauth-provider's combined `OAuthProvider`. The library serves /token, /register (dynamic client
// registration), the /.well-known/ metadata and the 401 challenge on /mcp; /authorize and /callback are ours
// (src/auth/oauth.ts). Loaded with a dynamic import() only for those paths, so the board never loads the library.
import { type OAuthHelpers, OAuthProvider } from "@cloudflare/workers-oauth-provider";
import type { Env } from "../env.ts";
import { allowedHostnames, MCP_ROUTE } from "../mcp/route.ts";
import { withSecurityHeaders } from "../security.ts";
import { SIGN_IN_NOT_SET_UP } from "./access.ts";
import { handleAuthorize, handleCallback, type OAuthDeps } from "./oauth.ts";
import { AUTHORIZE_PATH, CALLBACK_PATH, isAllowedOAuthHost, REGISTER_PATH, TOKEN_PATH } from "./oauth-routes.ts";
import { isOwnerEmail } from "./owners.ts";

/** Serves a signed-in /mcp request; the email is the owner's, from the token's props. */
export type McpHandler = (request: Request, env: Env, ctx: ExecutionContext, email: string) => Promise<Response>;

type ProviderEnv = Env & { OAUTH_PROVIDER?: OAuthHelpers };

/** Test seams for the calls to Cloudflare Access (the token endpoint and the signing keys). */
export type UpstreamDeps = Omit<OAuthDeps, "oauth">;

function text(status: number, message: string): Response {
  return new Response(`${message}\n`, { status, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" } });
}

/**
 * The resource is the URL clients connect to, so it is built per request from the request's origin (the library's
 * migration guide describes this for a Worker on several hostnames); isAllowedOAuthHost limits which origins exist.
 */
export function createOAuthProvider(origin: string, mcp: McpHandler, deps: UpstreamDeps = {}): OAuthProvider<ProviderEnv> {
  return new OAuthProvider<ProviderEnv>({
    apiRoute: MCP_ROUTE,
    apiHandler: {
      async fetch(request, env, ctx) {
        const email = (ctx.props as { email?: unknown } | undefined)?.email;
        // Checked on every request, so removing an owner email cuts off tokens issued before.
        if (typeof email !== "string" || !(await isOwnerEmail(env.DB, env, email))) {
          console.log(JSON.stringify({ event: "mcp_not_owner" }));
          return text(403, "This account isn't allowed to use this pipeline any more. Connect again with an owner's email.");
        }
        return mcp(request, env, ctx, email);
      },
    },
    defaultHandler: {
      async fetch(request, env) {
        const oauth = env.OAUTH_PROVIDER;
        if (!oauth) throw new Error("workers-oauth-provider did not supply its helpers.");
        const { pathname } = new URL(request.url);
        if (pathname === AUTHORIZE_PATH) return handleAuthorize(request, env, { ...deps, oauth });
        if (pathname === CALLBACK_PATH) return handleCallback(request, env, { ...deps, oauth });
        return text(404, "There's nothing at this address.");
      },
    },
    authorizeEndpoint: AUTHORIZE_PATH,
    tokenEndpoint: TOKEN_PATH,
    clientRegistrationEndpoint: REGISTER_PATH,
    resourceMetadata: { resource: `${origin}${MCP_ROUTE}`, resource_name: "Pipeline" },
    // Fixed fields only: the library's default logs the error description, which can quote what a client sent.
    onError: ({ code, status, internal }) => {
      console.log(JSON.stringify({ event: "oauth_error", code, status, reason: internal.reason }));
    },
  });
}

/** Every request on an OAuth path (src/auth/oauth-routes.ts) in production mode. */
export async function handleOAuth(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  mcp: McpHandler,
  deps: UpstreamDeps = {},
): Promise<Response> {
  if (!env.OAUTH_KV) return withSecurityHeaders(text(500, SIGN_IN_NOT_SET_UP));
  const url = new URL(request.url);
  if (!isAllowedOAuthHost(url.hostname, allowedHostnames(env.MCP_ALLOWED_HOSTNAMES))) {
    return withSecurityHeaders(
      text(403, "/mcp isn't set up for this hostname. Add it to MCP_ALLOWED_HOSTNAMES (docs/ACCESS-SETUP.md)."),
    );
  }
  // A copy of env: the library stores its helpers on the env it is given, and those are tied to this request's origin.
  const response = await createOAuthProvider(url.origin, mcp, deps).fetch(request, { ...env }, ctx);
  return withSecurityHeaders(response);
}
