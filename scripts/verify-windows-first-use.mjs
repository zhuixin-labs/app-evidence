// Run after build/pack. Uses one CLI install, an empty prefix, and an empty APPDATA.
// --packages <dir> serves candidate tarballs through a temporary local registry.
// Without --packages, tests the public npm release. Never writes the real Codex config.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { createHash } from "node:crypto";
import { spawn, execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

if (process.platform !== "win32") throw new Error("Windows host required");
const args = process.argv.slice(2);
const option = name => args.includes(name) ? args[args.indexOf(name) + 1] : undefined;
const root = fs.mkdtempSync(path.join(os.tmpdir(), "apptrace first use "));
const prefix = path.join(root, "npm");
const home = path.join(root, "user home");
fs.mkdirSync(home, { recursive: true });
const env = { ...process.env };
for (const key of Object.keys(env)) {
  if (/^(APPTRACE|REA|NPM_CONFIG)_/i.test(key) || /^(PATH|PSModulePath)$/i.test(key)) delete env[key];
}
Object.assign(env, {
  USERPROFILE: home,
  HOME: home,
  APPDATA: path.join(root, "roaming"),
  LOCALAPPDATA: path.join(root, "local"),
  PATH: [prefix, path.dirname(process.execPath), path.join(process.env.SystemRoot, "System32"), path.join(process.env.SystemRoot, "System32/WindowsPowerShell/v1.0")].join(";"),
  npm_config_cache: path.join(root, "npm-cache"),
  npm_config_userconfig: path.join(root, "empty.npmrc")
});
fs.writeFileSync(env.npm_config_userconfig, "");
const powershell = path.join(process.env.SystemRoot, "System32/WindowsPowerShell/v1.0/powershell.exe");
const quote = value => "'" + value.replaceAll("'", "''") + "'";
const results = [];
let registry;
console.log(`Evidence: ${root}`);

async function run(name, command, expected = 0) {
  console.log(`START ${name}`);
  const log = fs.createWriteStream(path.join(root, `${name}.log`));
  const child = spawn(powershell, ["-NoProfile", "-Command", `${command}; exit $LASTEXITCODE`], { env, cwd: home, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  for (const stream of [child.stdout, child.stderr]) stream.on("data", data => { output += data; log.write(data); });
  const code = await new Promise((resolve, reject) => { child.on("error", reject); child.on("close", resolve); });
  log.end();
  results.push({ name, code, expected, passed: code === expected });
  fs.writeFileSync(path.join(root, "results.json"), JSON.stringify(results, null, 2));
  if (code !== expected) throw new Error(`${name} exited ${code}; see ${root}`);
  console.log(`PASS ${name}`);
  return output;
}

try {
  let registryUrl = "https://registry.npmjs.org";
  const packages = option("--packages");
  if (packages) {
    const candidates = new Map();
    for (const file of fs.readdirSync(packages).filter(name => /^zhuixin-.*\.tgz$/.test(name))) {
      const filename = path.resolve(packages, file);
      const manifest = JSON.parse(execFileSync("tar.exe", ["-xOf", filename, "package/package.json"], { encoding: "utf8" }));
      candidates.set(manifest.name, { manifest, bytes: fs.readFileSync(filename) });
    }
    for (const name of ["cli", "mcp", "metadata", "shared", "protocol", "engine-client"]) {
      if (!candidates.has(`@zhuixin/${name}`)) throw new Error(`Missing candidate ${name}`);
    }
    registry = http.createServer((req, res) => {
      const name = decodeURIComponent(req.url.slice(1)).split("?")[0];
      const asset = name.endsWith("/-/candidate.tgz");
      const item = candidates.get(asset ? name.replace("/-/candidate.tgz", "") : name);
      if (!item) { res.writeHead(302, { Location: `https://registry.npmjs.org${req.url}` }); res.end(); return; }
      if (asset) { res.end(item.bytes); return; }
      const manifest = { ...item.manifest, dist: { tarball: `${registryUrl}/${item.manifest.name}/-/candidate.tgz`, integrity: `sha512-${createHash("sha512").update(item.bytes).digest("base64")}` } };
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ name, "dist-tags": { latest: manifest.version }, versions: { [manifest.version]: manifest } }));
    });
    await new Promise(resolve => registry.listen(0, "127.0.0.1", resolve));
    registryUrl = `http://127.0.0.1:${registry.address().port}`;
  }
  await run("01-install", `npm install -g --prefix ${quote(prefix)} --registry ${quote(registryUrl)} --no-audit --no-fund @zhuixin/cli`);
  const login = await run("02-login-before-setup", "apptrace auth login", 1);
  if (!login.includes("TOOL_NOT_INSTALLED") || !login.includes("apptrace setup --install")) {
    throw new Error("Missing dependency has no actionable onboarding message; see 02-login-before-setup.log");
  }
  const config = path.join(home, ".codex", "config.toml");
  await run("03-connect-before-tools", `apptrace setup --write-config ${quote(config)} --install-skill`);
  if (!fs.existsSync(path.join(home, ".codex", "skills", "apptrace", "SKILL.md"))) throw new Error("Skill not installed");
  const { parse } = createRequire(new URL("../packages/cli/package.json", import.meta.url))("smol-toml");
  const server = parse(fs.readFileSync(config, "utf8")).mcp_servers.apptrace;
  const entryRelative = path.relative(fs.realpathSync.native(prefix), fs.realpathSync.native(server.args[0]));
  if (entryRelative.startsWith("..") || path.isAbsolute(entryRelative)) throw new Error("MCP entry escaped clean installation");
  const client = new Client({ name: "first-use", version: "1.0.0" });
  try {
    await client.connect(new StdioClientTransport({ ...server, cwd: home, env: { ...env, ...server.env }, stderr: "pipe" }));
    const tools = await client.listTools();
    if (tools.tools.length !== 15) throw new Error("Expected fifteen MCP tools");
    const call = async (name, args = {}) => {
      const response = await client.callTool({ name, arguments: args });
      if (response.isError) throw new Error(`${name}: ${JSON.stringify(response)}`);
      return JSON.parse(response.content.find(item => item.type === "text").text);
    };
    if ((await call("get_setup_status")).state !== "tools_missing") throw new Error("Expected clean missing tools");
    const original = { source: "123456789", goals: ["tech_stack"], wait_seconds: 0 };
    const suspended = await call("analyze_app", original);
    if (suspended.status !== "awaiting_setup" || JSON.stringify(suspended.resume.arguments) !== JSON.stringify(original)) throw new Error("Original analysis not preserved");
    if ((await call("prepare_environment")).state !== "installing") throw new Error("Expected existing install to be reused");
    console.log("START 04-agent-install");
    const deadline = Date.now() + 20 * 60_000;
    let status;
    const progress = [];
    do {
      status = await call("get_setup_status", { wait_seconds: 20, require_account: false });
      progress.push(status);
      fs.writeFileSync(path.join(root, "04-agent-install.json"), JSON.stringify(progress, null, 2));
      console.log(`SETUP ${status.state} ${status.phase ?? ""}`);
    } while (status.state === "installing" && Date.now() < deadline);
    if (status.state !== "ready") throw new Error(`Setup did not complete: ${JSON.stringify(status)}`);
    const health = JSON.parse(await run("05-new-shell-doctor", "apptrace doctor --json"));
    if (health.health.tools.some(tool => !tool.available)) throw new Error("Doctor reported missing tools");
    if (!health.config.ipatoolPath.startsWith(env.APPDATA)) throw new Error("Borrowed ipatool from another workspace");
    for (const name of ["list_targets", "list_capabilities"]) {
      if ((await client.callTool({ name, arguments: {} })).isError) throw new Error(`${name} failed`);
    }
    fs.writeFileSync(path.join(root, "06-mcp.json"), JSON.stringify({ version: client.getServerVersion(), tools: tools.tools.map(tool => tool.name) }, null, 2));
  } finally { await client.close(); }
  console.log("PASS clean CLI install/MCP-first/agent setup/resume contract/new-shell. Interactive Apple login and desktop discovery remain manual.");
} finally {
  registry?.close();
}
