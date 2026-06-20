// Server bootstrap + stdio transport. Registers the five tools and connects.
// Never write to stdout — it corrupts the stdio protocol; log to stderr only.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { tools } from "./tools.js";

async function main(): Promise<void> {
  const server = new McpServer({ name: "betabot-mcp", version: "0.1.0" });

  for (const tool of tools) {
    server.registerTool(tool.name, tool.config, tool.handler);
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write("betabot-mcp running on stdio\n");
}

main().catch((err) => {
  process.stderr.write(`betabot-mcp fatal: ${(err as Error).stack ?? String(err)}\n`);
  process.exit(1);
});
