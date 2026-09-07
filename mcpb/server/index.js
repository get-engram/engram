#!/usr/bin/env node
/**
 * Engram desktop extension entry point.
 *
 * Deliberately a thin launcher around mcp-remote rather than a local MCP
 * server: Engram's server is remote (mcp.getengram.app) and authenticates
 * with OAuth — the same flow the ChatGPT connector and the Claude Code
 * plugin use. mcp-remote bridges Claude Desktop's stdio transport to the
 * remote HTTP transport and drives the browser OAuth flow on first use, so
 * there is no API key to paste and nothing stored in the bundle.
 *
 * Notably NOT `npx @getengram/cli mcp`: the CLI has no such command — the
 * old README instruction referencing it never worked.
 */
const { spawn } = require("node:child_process");

const child = spawn(
  process.execPath,
  [
    require.resolve("mcp-remote/dist/proxy.js"),
    "https://mcp.getengram.app/mcp",
  ],
  { stdio: "inherit" },
);
child.on("exit", (code) => process.exit(code ?? 0));
