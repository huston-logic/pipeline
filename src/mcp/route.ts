// The MCP endpoint's path, in a module of its own so the Worker's router can name it without loading the MCP SDK.
export const MCP_ROUTE = "/mcp";

/** MCP_ALLOWED_HOSTNAMES ("pipeline.example.com, other.example.com") as a list, or undefined when unset. */
export function allowedHostnames(value: string | undefined): string[] | undefined {
  const hosts = (value ?? "")
    .split(",")
    .map((host) => host.trim().toLowerCase())
    .filter((host) => host !== "");
  return hosts.length > 0 ? hosts : undefined;
}
