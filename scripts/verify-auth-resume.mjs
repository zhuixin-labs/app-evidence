import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { execFileSync, spawnSync } from "node:child_process";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const metadata = path.join(repo, "packages/metadata/dist/index.js");
const { AnalysisTasks, createStore, startAnalysisWorker, loadConfig } = require(metadata);
const root = fs.mkdtempSync(path.join(os.tmpdir(), "apptrace auth resume "));
const go = process.env.APPTRACE_TEST_GO || "go";
const fixture = path.join(root, process.platform === "win32" ? "ipatool.exe" : "ipatool");
execFileSync(go, ["build", "-o", fixture, path.join(repo, "packages/metadata/tests/fixtures/ipatool.go")], { stdio: "inherit" });
const engine = path.join(repo, "packages/metadata/tests/fixtures/engine.js");
const env = { ...process.env, USERPROFILE: root, HOME: root, APPTRACE_WORKSPACE_ROOT: root, APPTRACE_IPATOOL_PATH: fixture, APPTRACE_ENGINE_PATH: engine, APPTRACE_ANALYSIS_ENGINE_PATH: fixture, APPTRACE_FIXTURE_METADATA: metadata };
const rejectedLogin = spawnSync(process.execPath, [path.join(repo, "packages/cli/dist/index.js"), "auth", "login"], { env, encoding: "utf8", windowsHide: true });
if (rejectedLogin.status !== 1 || !rejectedLogin.stderr.includes("BACKGROUND_AUTH_FAILED")) throw new Error("CLI treated interactive success as verified background authentication");
console.log("PASS: CLI rejects interactive-only success when background credentials remain unavailable");
const tasks = new AnalysisTasks(root);
const store = createStore(path.join(root, "workbench.sqlite"));
const targetId = randomUUID();
const now = new Date().toISOString();
store.upsertTarget({ id: targetId, targetRef: { platform: "ios", sourceId: "app-store", sourceRef: "123" }, name: "Controlled fixture", slug: "fixture", metadata: {}, createdAt: now, updatedAt: now });
store.close();
const saved = tasks.create({ target_id: targetId, goals: ["report"] });
const token = tasks.claim(saved.id);
tasks.update(saved.id, token, { loginAttempted: true, status: "awaiting_auth" });
tasks.release(saved.id, token);
let client;
const connect = async () => {
  const next = new Client({ name: "auth-resume-test", version: "1" });
  await next.connect(new StdioClientTransport({ command: process.execPath, args: [path.join(repo, "packages/cli/dist/index.js"), "mcp"], env, stderr: "pipe" }));
  return next;
};
const waitFor = async predicate => {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 100)); }
  throw new Error(`Timed out: ${JSON.stringify(tasks.get(saved.id))}`);
};
try {
  client = await connect();
  const response = await client.callTool({ name: "analyze_app", arguments: { target_id: targetId, goals: ["report"], wait_seconds: 0 } });
  if (response.isError) throw new Error(JSON.stringify(response));
  const task = JSON.parse(response.content[0].text);
  if (task.runId !== saved.id) throw new Error("request was duplicated");
  await waitFor(() => tasks.get(saved.id)?.status === "awaiting_auth");
  if (fs.existsSync(path.join(root, "fixture-downloads"))) throw new Error("download started before authentication");
  await client.close(); client = undefined;
  fs.writeFileSync(path.join(root, "fixture-ready"), "authenticated");
  await waitFor(() => ["completed", "failed"].includes(tasks.get(saved.id)?.status));
  const completed = tasks.get(saved.id);
  if (completed.status !== "completed") throw new Error(JSON.stringify(completed));
  if (fs.readFileSync(path.join(root, "fixture-downloads"), "utf8").trim() !== "download") throw new Error("duplicate downloads");
  client = await connect();
  const fetched = await client.callTool({ name: "get_analysis_run", arguments: { run_id: saved.id, wait_seconds: 0 } });
  if (JSON.parse(fetched.content[0].text).status !== "completed") throw new Error("result did not survive reconnect");
  console.log(`PASS: authentication wait → MCP disconnect → controlled download/analysis exactly once → reconnect result (${saved.id})`);
  await client.close(); client = undefined;
  fs.rmSync(path.join(root, "fixture-ready"));
  const restartedId = randomUUID();
  const secondStore = createStore(path.join(root, "workbench.sqlite"));
  secondStore.upsertTarget({ id: restartedId, targetRef: { platform: "ios", sourceId: "app-store", sourceRef: "124" }, name: "Restart fixture", slug: "restart", metadata: {}, createdAt: now, updatedAt: now });
  secondStore.close();
  const restartTask = tasks.create({ target_id: restartedId, goals: ["report"] });
  const restartToken = tasks.claim(restartTask.id);
  tasks.update(restartTask.id, restartToken, { loginAttempted: true, status: "awaiting_auth" });
  tasks.release(restartTask.id, restartToken);
  client = await connect();
  const waitRestart = async predicate => {
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 100)); }
    throw new Error(`Restart timed out: ${JSON.stringify(tasks.get(restartTask.id))}`);
  };
  await waitRestart(() => tasks.get(restartTask.id)?.status === "awaiting_auth" && tasks.get(restartTask.id)?.owner);
  const owner = tasks.get(restartTask.id).owner;
  process.kill(owner.pid, "SIGKILL");
  await client.close(); client = undefined;
  // Let the crashed worker's lease expire; recovery also checks child liveness.
  await new Promise(resolve => setTimeout(resolve, 16000));
  fs.writeFileSync(path.join(root, "fixture-ready"), "authenticated");
  client = await connect();
  await waitRestart(() => ["completed", "failed"].includes(tasks.get(restartTask.id)?.status));
  if (tasks.get(restartTask.id)?.status !== "completed") throw new Error(JSON.stringify(tasks.get(restartTask.id)));
  if (fs.readFileSync(path.join(root, "fixture-downloads"), "utf8").trim().split("\n").length !== 2) throw new Error("restart duplicated download");
  console.log("PASS: abrupt waiting-worker termination → new MCP session → original task recovered exactly once");
  const discoveryRoot = path.join(root, "auto-discovery");
  const discoveredTool = path.join(discoveryRoot, "tools", "ipatool", "bin", process.platform === "win32" ? "ipatool.exe" : "ipatool");
  fs.mkdirSync(path.dirname(discoveredTool), { recursive: true });
  fs.copyFileSync(fixture, discoveredTool);
  if (process.platform !== "win32") fs.chmodSync(discoveredTool, 0o700);
  const discoveryWorkspace = path.join(discoveryRoot, "workspace");
  const discoveryTasks = new AnalysisTasks(discoveryWorkspace);
  const discoveryTask = discoveryTasks.create({ source: "fixture" });
  const receipt = path.join(discoveryRoot, "received-config.json");
  const probe = path.join(discoveryRoot, "probe.js");
  fs.writeFileSync(probe, `const {loadConfig}=require(${JSON.stringify(metadata)});const config=loadConfig();require('node:fs').writeFileSync(${JSON.stringify(receipt)},JSON.stringify({managed:config.ipatoolManaged,path:config.ipatoolPath}));`);
  const previousCwd = process.cwd();
  process.chdir(discoveryRoot);
  try {
    const config = loadConfig({ APPTRACE_WORKSPACE_ROOT: discoveryWorkspace, APPTRACE_ENGINE_PATH: engine, APPTRACE_ANALYSIS_ENGINE_PATH: fixture });
    if (!config.ipatoolManaged || config.ipatoolPath !== discoveredTool) throw new Error("fixture was not auto-discovered");
    await startAnalysisWorker(config, discoveryTask.id, probe);
    await waitRestart(() => fs.existsSync(receipt));
    const received = JSON.parse(fs.readFileSync(receipt, "utf8"));
    if (!received.managed || received.path !== discoveredTool) throw new Error("detached launch lost tool provenance");
    discoveryTasks.cancel(discoveryTask.id);
  } finally { process.chdir(previousCwd); }
  console.log("PASS: automatic legacy-tool provenance survives the detached worker boundary");
} finally {
  for (const task of tasks.list()) tasks.cancel(task.id);
  await client?.close();
  // A detached worker needs up to one polling interval to release its files.
  await new Promise(resolve => setTimeout(resolve, 2500));
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}
