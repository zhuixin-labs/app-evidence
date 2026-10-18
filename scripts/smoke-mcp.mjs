import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const client = new Client({ name: "apptrace-smoke", version: "0.1.0" });
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [path.join(root, "packages/mcp/dist/index.js")],
  cwd: root,
  env: {
    ...process.env,
    APPTRACE_WORKSPACE_ROOT:
      process.env.APPTRACE_WORKSPACE_ROOT ??
      path.join(root, ".apptrace", "smoke-workspace")
  },
  stderr: "pipe"
});

transport.stderr?.on("data", (chunk) => {
  process.stderr.write(`[apptrace-mcp] ${chunk}`);
});

try {
  await client.connect(transport);
  const { tools } = await client.listTools();
  const names = tools.map((tool) => tool.name);
  for (const required of [
    "analyze_app",
    "get_analysis_run",
    "list_targets",
    "auth_status",
    "get_job",
    "search_findings",
    "search_native",
    "decompile_function",
    "list_evidence",
    "compare_versions",
    "generate_report"
  ]) {
    if (!names.includes(required)) {
      throw new Error(`Missing MCP tool: ${required}`);
    }
  }
  const capabilities = await client.callTool({
    name: "list_capabilities",
    arguments: {}
  });
  if (capabilities.isError) {
    throw new Error("list_capabilities returned a tool error");
  }
  console.log(`PASS: MCP discovered ${names.length} tools`);
} finally {
  await client.close();
}
