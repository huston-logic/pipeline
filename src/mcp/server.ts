// The MCP server: an SDK v2 McpServer with every pipeline tool. createMcpHandler (src/mcp/handler.ts) builds a fresh
// one for each request, so nothing is shared between requests (decision 0004), except the converted JSON Schemas,
// frozen and kept per tool name in tool.ts (decision 0020).
import { McpServer } from "@modelcontextprotocol/server";
import { SERVER_INSTRUCTIONS } from "./instructions.ts";
import type { ToolDeps } from "./tool.ts";
import { registerCampaignTools } from "./tools-campaigns.ts";
import { registerImportTools } from "./tools-import.ts";
import { registerProposalTools } from "./tools-proposals.ts";
import { registerReadTools } from "./tools-read.ts";
import { registerTimeTools } from "./tools-time.ts";
import { registerViewTools } from "./tools-views.ts";
import { registerWriteTools } from "./tools-write.ts";

export const SERVER_INFO = { name: "pipeline", version: "0.1.0" };

export function createMcpServer(deps: ToolDeps): McpServer {
  const server = new McpServer(SERVER_INFO, { instructions: SERVER_INSTRUCTIONS });
  registerReadTools(server, deps);
  registerWriteTools(server, deps);
  registerImportTools(server, deps);
  registerViewTools(server, deps);
  registerProposalTools(server, deps);
  registerTimeTools(server, deps);
  registerCampaignTools(server, deps);
  return server;
}
