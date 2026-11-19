// /mcp over Streamable HTTP, served by the Agents SDK's createMcpHandler (stateless: a fresh McpServer per request,
// no Durable Object or session). The caller has already signed the request in; `email` reaches tools through
// getMcpAuthContext(). Decision 0004.
import { createMcpHandler } from "agents/mcp/server";
import type { Env } from "../env.ts";
import { allowedHostnames, MCP_ROUTE } from "./route.ts";
import { createMcpServer } from "./server.ts";

export function handleMcp(request: Request, env: Env, ctx: ExecutionContext, email: string): Promise<Response> {
  const hosts = allowedHostnames(env.MCP_ALLOWED_HOSTNAMES);
  const handler = createMcpHandler(() => createMcpServer({ db: env.DB, now: () => new Date() }), {
    route: MCP_ROUTE,
    authContext: { props: { email } },
    ...(hosts ? { allowedHostnames: hosts } : {}),
    onerror: () => console.error(JSON.stringify({ event: "mcp_request_failed" })),
  });
  return handler(request, env, ctx);
}
