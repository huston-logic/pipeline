// The paths production OAuth owns, in a module of its own so the router can name them without loading
// workers-oauth-provider (decision 0006). Cloudflare Access must bypass every one of them (docs/ACCESS-SETUP.md).
import { MCP_ROUTE } from "../mcp/route.ts";

export const AUTHORIZE_PATH = "/authorize";
export const CALLBACK_PATH = "/callback";
export const TOKEN_PATH = "/token";
export const REGISTER_PATH = "/register";
const WELL_KNOWN = "/.well-known/";

const PATHS = new Set([MCP_ROUTE, AUTHORIZE_PATH, CALLBACK_PATH, TOKEN_PATH, REGISTER_PATH]);

export function isOAuthPath(pathname: string): boolean {
  return PATHS.has(pathname) || pathname.startsWith(WELL_KNOWN);
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * Whether /mcp and its sign-in may answer on this host: one listed in MCP_ALLOWED_HOSTNAMES when it is set; otherwise
 * a *.workers.dev host (including preview URLs) or a loopback host. A custom domain must be listed, so tokens are never
 * issued for a host nobody configured.
 */
export function isAllowedOAuthHost(hostname: string, allowed: readonly string[] | undefined): boolean {
  const host = hostname.toLowerCase();
  if (allowed) return allowed.includes(host);
  return host.endsWith(".workers.dev") || LOOPBACK_HOSTS.has(host);
}
