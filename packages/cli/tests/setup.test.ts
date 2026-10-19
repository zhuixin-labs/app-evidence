import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import { parse } from "smol-toml";
import { writeMcpConfig } from "../src/mcp-config.js";
import { loadConfig } from "../../metadata/src/config.js";
import { resolveTool } from "../../metadata/src/tools.js";

const roots: string[] = [];
function temporary() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "apptrace setup "));
  roots.push(root);
  return root;
}
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
const server = { command: process.execPath, args: ["C:\\space dir\\server.js"], env: { APPTRACE_WORKSPACE_ROOT: "C:\\工作区" } };

test.each(["json", "toml"])("merges %s config without losing other settings or server options", (format) => {
  const root = temporary();
  const file = path.join(root, `config.${format}`);
  const original = format === "json"
    ? JSON.stringify({ theme: "dark", mcpServers: { other: { command: "other" }, apptrace: { disabled: true, env: { CUSTOM: "kept" } } } })
    : '# comment\ntheme="dark"\n[mcp_servers.other]\ncommand="other"\n[mcp_servers.apptrace]\ndisabled=true\n[mcp_servers.apptrace.env]\nCUSTOM="kept"\n';
  fs.writeFileSync(file, original);
  writeMcpConfig(file, server);
  writeMcpConfig(file, server);
  const result = format === "json" ? JSON.parse(fs.readFileSync(file, "utf8")) : parse(fs.readFileSync(file, "utf8")) as any;
  const servers = result[format === "json" ? "mcpServers" : "mcp_servers"];
  expect(result.theme).toBe("dark");
  expect(servers.other.command).toBe("other");
  expect(servers.apptrace).toMatchObject({ ...server, disabled: true, env: { CUSTOM: "kept" } });
  expect(fs.readdirSync(root).filter(name => name.endsWith(".bak")).some(name => fs.readFileSync(path.join(root, name), "utf8") === original)).toBe(true);
});

test.each(["json", "toml"])("leaves invalid %s configuration untouched", (format) => {
  const file = path.join(temporary(), `config.${format}`);
  fs.writeFileSync(file, "[broken");
  expect(() => writeMcpConfig(file, server)).toThrow();
  expect(fs.readFileSync(file, "utf8")).toBe("[broken");
});

test("resolves PATH executables and rejects missing commands and directories", () => {
  const root = temporary();
  const filename = path.join(root, process.platform === "win32" ? "example.EXE" : "example");
  fs.writeFileSync(filename, "", { mode: 0o700 });
  expect(resolveTool("example", { PATH: root, PATHEXT: ".EXE;.CMD" })).toBe(filename);
  expect(resolveTool("missing", { PATH: root })).toBeUndefined();
  expect(resolveTool(root)).toBeUndefined();
});

test("discovers installed workspace launcher and preserves explicit missing overrides", () => {
  const root = temporary();
  const launcher = path.join(root, "tools", "bin", "rea.cmd");
  fs.mkdirSync(path.dirname(launcher), { recursive: true });
  fs.writeFileSync(launcher, "@echo off");
  expect(loadConfig({ APPTRACE_WORKSPACE_ROOT: root }, "win32").analysisEnginePath).toBe(launcher);
  expect(loadConfig({ APPTRACE_WORKSPACE_ROOT: root, APPTRACE_ANALYSIS_ENGINE_PATH: "missing-rea" }, "win32").analysisEnginePath).toBe("missing-rea");
});
