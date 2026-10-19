import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { parse, stringify } from "smol-toml";

interface ServerConfig {
  command: string;
  args: string[];
  env: Record<string, string>;
}

function object(value: unknown): Record<string, any> {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("MCP configuration must contain objects/tables.");
  }
  return value as Record<string, any>;
}

export function writeMcpConfig(filename: string, server: ServerConfig): void {
  const extension = path.extname(filename).toLowerCase();
  if (![".json", ".toml"].includes(extension)) {
    throw new Error("--write-config accepts only .json or .toml files.");
  }
  const original = fs.existsSync(filename) ? fs.readFileSync(filename, "utf8") : undefined;
  const config = object(original?.trim()
    ? extension === ".json" ? JSON.parse(original) : parse(original)
    : {});
  const key = extension === ".json" ? "mcpServers" : "mcp_servers";
  const servers = object(config[key]);
  const previous = object(servers.apptrace);
  const environment = { ...object(previous.env), ...server.env };
  for (const [key, placeholder] of [["APPTRACE_IPATOOL_PATH", "ipatool"], ["APPTRACE_ANALYSIS_ENGINE_PATH", "rea"]]) {
    if (!server.env[key] && environment[key] === placeholder) delete environment[key];
  }
  servers.apptrace = { ...previous, ...server, env: environment };
  config[key] = servers;
  const output = extension === ".json" ? JSON.stringify(config, null, 2) + "\n" : stringify(config);
  fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
  // Keep the original text (including TOML comments) recoverable before serialization.
  if (original !== undefined) {
    fs.writeFileSync(`${filename}.${randomUUID()}.bak`, original, { mode: 0o600, flag: "wx" });
  }
  const temporary = `${filename}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, output, { mode: 0o600, flag: "wx" });
    fs.renameSync(temporary, filename);
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}
