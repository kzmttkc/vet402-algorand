#!/usr/bin/env node
/**
 * vet402 MCP server (stdio).
 *
 *   vet402_check              {url}                   paid: 0.05 USDC per call
 *   algorand_x402_endpoints   {query?, network?, limit?}   free
 *
 * stdout carries JSON-RPC only; anything a library prints goes to stderr.
 */
import "./stdout-guard.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CHECK_TOOL, ENDPOINTS_TOOL, runCheck, runEndpoints } from "./tools.js";

const server = new McpServer({ name: "vet402-algorand", version: "0.1.0" });

server.registerTool(CHECK_TOOL.name, CHECK_TOOL.config, async ({ url }) => runCheck({ url }));
server.registerTool(ENDPOINTS_TOOL.name, ENDPOINTS_TOOL.config, async (args) => runEndpoints(args));

await server.connect(new StdioServerTransport());
