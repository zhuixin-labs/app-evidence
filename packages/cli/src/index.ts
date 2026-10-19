#!/usr/bin/env node
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import {
  AppAnalysisService,
  CoreFailure,
  CoreServer,
  installEngineArtifact,
  VersionComparisonService,
  loadConfig,
  resolveTool,
  OnboardingService,
  runInstallation,
  missingSetupTools,
  trackInstallationChild,
  type AnalysisGoal,
  type AnalyzeAppResult
} from "@zhuixin/metadata";
import {
  CHANNELS,
  type CapabilityDescriptor,
  type HealthInfo,
  type JobRecord,
  type TargetRecord
} from "@zhuixin/shared";

import { version } from "../package.json";
import { writeMcpConfig } from "./mcp-config.js";

const GOALS: AnalysisGoal[] = [
  "tech_stack",
  "feature_map",
  "network",
  "native_risk",
  "report"
];

function usage(): void {
  console.log(`AppTrace ${version}

Usage:
  apptrace setup [--json] [--install] [--write-config <path>] [--restart-client]
  apptrace doctor [--json]
  apptrace auth login
  apptrace auth status
  apptrace auth open
  apptrace setup --write-config <path> --install-skill
  apptrace targets add <app-store-url-or-id>
  apptrace targets list
  apptrace analyze [app-store-url-or-id] [--target <target-id>] [--goals ...] [--force]
  apptrace report <target-id>
  apptrace jobs get <job-id>
  apptrace search <target-id> [query] [--type route,module] [--limit 50]
  apptrace native search <target-id> <query> [--kind procedures|strings]
  apptrace native decompile <target-id> <function-name>
  apptrace evidence <target-id>
  apptrace compare <target-id> <left-artifact-id> <right-artifact-id> [--force]
  apptrace capabilities [target-id]
  apptrace engine install <engine-file> [--sha256 <digest>]
  apptrace mcp

Examples:
  apptrace analyze https://apps.apple.com/cn/app/id1616124777
  apptrace analyze 1616124777 --goals tech_stack,feature_map,native_risk,report
`);
}

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index >= 0 && args[index + 1]) return args[index + 1];
  const prefix = `${name}=`;
  const inline = args.find((arg) => arg.startsWith(prefix));
  return inline ? inline.slice(prefix.length) : undefined;
}

function hasFlag(args: string[], name: string): boolean {
  return args.includes(name);
}

function positional(args: string[]): string | undefined {
  return args.find((arg) => !arg.startsWith("--"));
}

function parseGoals(value: string | undefined): AnalysisGoal[] {
  if (!value) return ["tech_stack", "feature_map", "report"];
  const goals = value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  const invalid = goals.filter(
    (goal): goal is string => !GOALS.includes(goal as AnalysisGoal)
  );
  if (invalid.length > 0) {
    throw new CoreFailure(
      "INVALID_INPUT",
      `未知分析目标：${invalid.join(", ")}。可选：${GOALS.join(", ")}`
    );
  }
  return goals as AnalysisGoal[];
}

function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function printError(error: unknown): void {
  if (error instanceof CoreFailure) {
    console.error(`${error.code}: ${error.message}`);
    if (error.code === "AUTH_REQUIRED" || error.code === "KEYCHAIN_LOCKED") {
      console.error("Next: apptrace auth login");
    } else if (error.code === "LICENSE_REQUIRED") {
      console.error("Next: 在 iPhone App Store 获取或购买该应用后重试。");
    }
    return;
  }
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
}

function withCore<T>(operation: (core: CoreServer) => Promise<T>): Promise<T> {
  const core = new CoreServer({ config: loadConfig(), emit: () => {} });
  return operation(core).finally(() => core.close());
}

function interactive(
  command: string,
  args: string[],
  env?: NodeJS.ProcessEnv,
  onSpawn?: (pid: number) => void
): Promise<number | null> {
  return new Promise((resolve, reject) => {
    const isWindowsCommand =
      process.platform === "win32" &&
      [".cmd", ".bat"].includes(path.extname(command).toLowerCase());
    const child = isWindowsCommand
      ? spawn(
          process.env.ComSpec || "cmd.exe",
          ["/d", "/s", "/c", `"${command}" ${args.join(" ")}`],
          {
            stdio: "inherit",
            windowsVerbatimArguments: true,
            env: env ? { ...process.env, ...env } : process.env
          }
        )
      : spawn(command, args, {
          stdio: "inherit",
          env: env ? { ...process.env, ...env } : process.env
        });
    if (child.pid && onSpawn) {
      try { onSpawn(child.pid); }
      catch (error) { child.kill(); reject(error); return; }
    }
    child.on("error", reject);
    child.on("exit", (code) => resolve(code));
  });
}

async function doctor(json: boolean): Promise<void> {
  const config = loadConfig();
  await withCore(async (core) => {
    const health = (await core.handle(CHANNELS.health, {})) as HealthInfo;
    const capabilities = (await core.handle(
      CHANNELS.capabilitiesList,
      {}
    )) as CapabilityDescriptor[];
    const result = { config, health, capabilities };
    if (json) {
      printJson(result);
      return;
    }
    console.log(`workspace: ${health.workspaceRoot}`);
    console.log(`host:      ${health.hostPlatform}`);
    console.log(`store:     ${health.store}`);
    console.log("tools:");
    for (const tool of health.tools ?? []) {
      console.log(
        `  ${tool.available ? "OK  " : "MISS"} ${tool.label}: ${tool.path}`
      );
    }
    console.log("capabilities:");
    for (const capability of capabilities) {
      console.log(
        `  ${capability.available ? "OK  " : "NO  "} ${capability.id}${
          capability.reason ? ` — ${capability.reason}` : ""
        }`
      );
    }
  });
}

function createEngineLauncher(workspaceRoot: string): string {
  const reaScript = require.resolve("rea-agents/scripts/rea.mjs");
  const tools = path.join(workspaceRoot, "tools");
  const javaHome = path.join(tools, "jdk");
  const ghidraHome = path.join(tools, "ghidra_12.1.4_PUBLIC");
  const ghidraUserHome = path.join(workspaceRoot, ".ghidra-home");
  fs.mkdirSync(path.join(tools, "bin"), { recursive: true, mode: 0o700 });
  fs.mkdirSync(ghidraUserHome, { recursive: true, mode: 0o700 });
  const launcher = path.join(
    tools,
    "bin",
    process.platform === "win32" ? "rea.cmd" : "rea"
  );
  if (process.platform === "win32") {
    fs.writeFileSync(
      launcher,
      [
        "@echo off",
        `set "JAVA_HOME=${javaHome}"`,
        `set "GHIDRA_INSTALL_DIR=${ghidraHome}"`,
        `set "GHIDRA_USER_HOME=${ghidraUserHome}"`,
        'set "PATH=%JAVA_HOME%\\bin;%PATH%"',
        `"${process.execPath}" "${reaScript}" %*`,
        ""
      ].join("\r\n"),
      { mode: 0o700 }
    );
  } else {
    fs.writeFileSync(
      launcher,
      [
        "#!/usr/bin/env bash",
        "set -euo pipefail",
        `export JAVA_HOME=${JSON.stringify(javaHome)}`,
        `export GHIDRA_INSTALL_DIR=${JSON.stringify(ghidraHome)}`,
        `export GHIDRA_USER_HOME=${JSON.stringify(ghidraUserHome)}`,
        'export PATH="$JAVA_HOME/bin:$PATH"',
        'export JAVA_TOOL_OPTIONS="${JAVA_TOOL_OPTIONS:-} -Duser.home=$GHIDRA_USER_HOME"',
        `exec ${JSON.stringify(process.execPath)} ${JSON.stringify(reaScript)} "$@"`,
        ""
      ].join("\n"),
      { mode: 0o700 }
    );
  }
  return launcher;
}

async function installTools(
  config: ReturnType<typeof loadConfig>,
  json = false
): Promise<void> {
  if (missingSetupTools(config).length === 0) {
    const managedLauncher = path.join(config.workspaceRoot, "tools", "bin", process.platform === "win32" ? "rea.cmd" : "rea");
    if (path.resolve(config.analysisEnginePath) === managedLauncher) {
      createEngineLauncher(config.workspaceRoot);
    }
    process.stderr.write("Tools already available; download skipped.\n");
    return;
  }
  if (process.platform === "win32" && process.arch === "x64") {
    const script = path.resolve(__dirname, "scripts/bootstrap-tools.ps1");
    if (!fs.existsSync(script)) {
      throw new CoreFailure("TOOL_INSTALLER_MISSING", `找不到安装脚本：${script}`);
    }
    process.stderr.write(
      "Installing JDK, Ghidra and ipatool for Windows x64. This can take several minutes.\n"
    );
    const code = await interactive("powershell.exe", [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      script,
      "-WorkspaceRoot",
      config.workspaceRoot
    ], {
      // PowerShell 7's inherited module paths can hide Windows PowerShell 5.1 modules.
      PSModulePath: path.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "Modules"),
      APPTRACE_WORKSPACE_ROOT: config.workspaceRoot,
      APPTRACE_TOOLS_DIR: path.join(config.workspaceRoot, "tools"),
      ...(process.env.APPTRACE_IPATOOL_SHA256
        ? { APPTRACE_IPATOOL_SHA256: process.env.APPTRACE_IPATOOL_SHA256 }
        : {})
    }, (pid) => trackInstallationChild(config, pid));
    if (code !== 0) {
      throw new CoreFailure(
        "TOOL_INSTALL_FAILED",
        `工具安装失败，退出码：${code ?? "unknown"}`
      );
    }
    const launcher = createEngineLauncher(config.workspaceRoot);
    process.stderr.write(`Analysis engine launcher: ${launcher}\n`);
    return;
  }
  if (process.platform !== "darwin" || process.arch !== "arm64") {
    throw new CoreFailure(
      "TOOL_INSTALL_UNSUPPORTED",
      "自动安装器当前支持 macOS arm64 和 Windows x64；其他平台请使用 APPTRACE_ENGINE_PATH 和 APPTRACE_IPATOOL_PATH。"
    );
  }
  const script = path.resolve(__dirname, "scripts/bootstrap-tools.sh");
  if (!fs.existsSync(script)) {
    throw new CoreFailure("TOOL_INSTALLER_MISSING", `找不到安装脚本：${script}`);
  }
  process.stderr.write(
    "Installing JDK, Ghidra and ipatool. This can take several minutes.\n"
  );
  const code = await interactive("/bin/bash", [script], {
    APPTRACE_WORKSPACE_ROOT: config.workspaceRoot,
    APPTRACE_TOOLS_DIR: path.join(config.workspaceRoot, "tools")
  }, (pid) => trackInstallationChild(config, pid));
  if (code !== 0) {
    throw new CoreFailure(
      "TOOL_INSTALL_FAILED",
      `工具安装失败，退出码：${code ?? "unknown"}`
    );
  }
  const launcher = createEngineLauncher(config.workspaceRoot);
  process.stderr.write(`Analysis engine launcher: ${launcher}\n`);
}

async function setup(json: boolean, args: string[]): Promise<void> {
  const configPath = option(args, "--write-config");
  if (hasFlag(args, "--install-skill") && !configPath) throw new CoreFailure("CONFIG_REQUIRED", "安装 Skill 时请同时指定 --write-config。");
  let config = loadConfig();
  if (hasFlag(args, "--install")) {
    await runInstallation(config, () => installTools(config, json));
    config = loadConfig();
  }
  await doctor(json);
  if (json && !configPath) return;
  const serverEntry = resolveMcpEntry();
  const env: Record<string, string> = {
    APPTRACE_WORKSPACE_ROOT: config.workspaceRoot,
    APPTRACE_CLI_PATH: __filename
  };
  const ipatool = resolveTool(config.ipatoolPath);
  if (ipatool) env.APPTRACE_IPATOOL_PATH = ipatool;
  if (fs.existsSync(config.enginePath)) {
    env.APPTRACE_ENGINE_PATH = config.enginePath;
  }
  // Only pin the analysis engine when it really exists, otherwise the engine
  // inherits a path that can never work instead of resolving its own default.
  if (fs.existsSync(config.analysisEnginePath)) {
    env.APPTRACE_ANALYSIS_ENGINE_PATH = config.analysisEnginePath;
  }
  if (configPath) {
    const absolute = path.resolve(configPath);
    writeMcpConfig(absolute, { command: process.execPath, args: [serverEntry], env });
    if (hasFlag(args, "--install-skill")) {
      const destination = path.join(path.dirname(absolute), "skills", "apptrace", "SKILL.md");
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      if (fs.existsSync(destination)) fs.copyFileSync(destination, `${destination}.${Date.now()}.bak`);
      fs.copyFileSync(path.join(__dirname, "skills", "apptrace", "SKILL.md"), destination);
    }
    if (json) {
      process.stderr.write(`MCP config written: ${absolute}\n`);
      return;
    }
    console.log(`配置已写入：${absolute}`);
  }
  const escape = (value: string) => value.replace(/\\/g, "\\\\");
  const envDisplay = Object.entries(env)
    .map(([key, value]) => `${key} = "${escape(value)}"`)
    .join(", ");
  console.log(`
MCP 配置（客户端读取这一段，键名保持英文）：

[mcp_servers.apptrace]
command = "${escape(process.execPath)}"
args = ["${escape(serverEntry)}"]
env = { ${envDisplay} }

重启 Agent 客户端后生效。加 --restart-client 可以让 AppTrace 直接重启它。
`);
  if (configPath && hasFlag(args, "--restart-client")) {
    const client = clientForConfig(path.resolve(configPath));
    if (!client.app) {
      throw new CoreFailure(
        "RESTART_UNSUPPORTED",
        `${client.name} 需要你自己重启（退出后重新打开）。`
      );
    }
    await restartClient(client.app);
    console.log(`已重启 ${client.name}。`);
  }
}

function clientForConfig(configPath: string): { name: string; app?: string } {
  const normalized = configPath.replace(/\\/g, "/").toLowerCase();
  if (normalized.includes("claude_desktop_config.json")) {
    return { name: "Claude Desktop", app: "Claude" };
  }
  if (normalized.includes("/.codex/")) return { name: "Codex", app: "Codex" };
  if (normalized.includes("/.cursor/")) return { name: "Cursor", app: "Cursor" };
  if (normalized.endsWith(".mcp.json")) return { name: "Claude Code" };
  return { name: "Agent 客户端" };
}

async function restartClient(app: string): Promise<void> {
  if (process.platform !== "darwin") {
    throw new CoreFailure(
      "RESTART_UNSUPPORTED",
      "当前系统不支持自动重启客户端，请手动退出后重新打开。"
    );
  }
  await interactive("/usr/bin/osascript", ["-e", `quit app "${app}"`]);
  await new Promise((resolve) => setTimeout(resolve, 1200));
  await interactive("/usr/bin/open", ["-a", app]);
}

/**
 * Global installs nest workspace packages under the CLI package
 * (node_modules/@zhuixin/cli/node_modules/@zhuixin/mcp), so a fixed
 * ../../mcp path only works inside the monorepo.
 */
function resolveMcpEntry(): string {
  try {
    return require.resolve("@zhuixin/mcp");
  } catch {
    return path.resolve(__dirname, "../../mcp/dist/index.js");
  }
}

async function authLogin(): Promise<void> {
  const config = loadConfig();
  const ipatool = resolveTool(config.ipatoolPath);
  if (!ipatool) {
    throw new CoreFailure(
      "TOOL_NOT_INSTALLED",
      `找不到 ipatool（${config.ipatoolPath}）。请先运行 apptrace setup --install，成功后再运行 apptrace auth login。`
    );
  }
  const code = await interactive(ipatool, ["auth", "login"]);
  if (code !== 0) {
    throw new CoreFailure(
      "AUTH_FAILED",
      `ipatool 登录没有成功，退出码：${code ?? "unknown"}`
    );
  }
  await authStatus();
}

async function authStatus(): Promise<void> {
  await withCore(async (core) => {
    const status = await core.handle(CHANNELS.accountStatus, { force: true });
    printJson(status);
  });
}

async function addTarget(source: string): Promise<void> {
  await withCore(async (core) => {
    const resolved = (await core.handle(CHANNELS.targetsResolve, {
      input: source
    })) as { resolutionId: string };
    const target = (await core.handle(CHANNELS.targetsCreate, {
      resolutionId: resolved.resolutionId
    })) as TargetRecord;
    printJson(target);
  });
}

async function listTargets(): Promise<void> {
  await withCore(async (core) => {
    printJson(await core.handle(CHANNELS.targetsList, {}));
  });
}

async function analyze(source: string | undefined, args: string[]): Promise<void> {
  const goals = parseGoals(option(args, "--goals"));
  const json = hasFlag(args, "--json");
  const force = hasFlag(args, "--force");
  const targetId = option(args, "--target");
  if (!source && !targetId) {
    throw new CoreFailure("SOURCE_REQUIRED", "缺少应用链接、ID 或 --target。");
  }
  await withCore(async (core) => {
    const service = new AppAnalysisService(core);
    const result = await service.analyzeApp({
      source: targetId ? undefined : source,
      targetId,
      goals,
      force,
      onProgress: (event) => {
        if (!json) {
          process.stderr.write(
            `[${event.step}] ${event.status}${
              event.message ? ` — ${event.message}` : ""
            }\n`
          );
        }
      }
    });
    if (json) {
      printJson(result);
    } else {
      printAnalysis(result);
    }
  });
}

function printAnalysis(result: AnalyzeAppResult): void {
  console.log(`\n${result.targetName}`);
  console.log(`Target: ${result.targetId}`);
  console.log(`Artifact: ${result.artifact.sha256}`);
  console.log(
    `Technology: ${result.technology?.hints.join(" / ") || "unknown"}`
  );
  console.log(`Routes: ${result.routes?.count ?? 0}`);
  console.log(`Modules: ${result.modules?.count ?? 0}`);
  console.log(`Network endpoints: ${result.networkEndpoints?.count ?? 0}`);
  if (result.native) {
    console.log(
      `Native: ${result.native.procedureCount ?? "?"} procedures, ${
        result.native.stringCount ?? "?"
      } strings`
    );
    if (result.native.warning) console.log(`Warning: ${result.native.warning}`);
  }
  if (result.reportPath) console.log(`Report: ${result.reportPath}`);
  for (const evidencePath of result.evidencePaths) {
    console.log(`Evidence: ${evidencePath}`);
  }
  if (result.limitations.length > 0) {
    console.log("Limitations:");
    for (const limitation of result.limitations.slice(0, 6)) {
      console.log(`  - ${limitation}`);
    }
  }
}

async function report(targetId: string): Promise<void> {
  await withCore(async (core) => {
    const service = new AppAnalysisService(core);
    printJson(await service.runCapability(targetId, "generate:report"));
  });
}

async function getJob(jobId: string): Promise<void> {
  await withCore(async (core) => {
    const result = (await core.handle(CHANNELS.jobsGet, { jobId })) as {
      job: JobRecord;
      events: unknown[];
    };
    printJson({ ...result, events: result.events.slice(-50) });
  });
}

async function searchFindings(
  targetId: string,
  query: string | undefined,
  args: string[]
): Promise<void> {
  const types = option(args, "--type")
    ?.split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  const limit = Number(option(args, "--limit") ?? 50);
  await withCore(async (core) => {
    printJson(
      await core.handle(CHANNELS.findingsSearch, {
        targetId,
        query,
        types,
        limit: Number.isFinite(limit) ? limit : 50
      })
    );
  });
}

async function nativeCommand(
  action: string | undefined,
  args: string[]
): Promise<void> {
  const targetId = args[0];
  const value = args[1];
  if (!targetId || !value) {
    throw new CoreFailure(
      "INVALID_INPUT",
      "用法：apptrace native <search|decompile> <target-id> <query-or-function>"
    );
  }
  await withCore(async (core) => {
    const service = new AppAnalysisService(core);
    if (action === "search") {
      printJson(
        await service.runCapability(targetId, "native:search", {
          query: value,
          kind: option(args, "--kind") ?? "procedures",
          mode: option(args, "--mode") ?? "literal"
        })
      );
      return;
    }
    if (action === "decompile") {
      printJson(
        await service.runCapability(targetId, "native:decompile", {
          functionName: value
        })
      );
      return;
    }
    throw new CoreFailure(
      "INVALID_INPUT",
      "原生命令只支持 search 或 decompile。"
    );
  });
}

async function evidence(targetId: string): Promise<void> {
  await withCore(async (core) => {
    printJson(
      await core.handle(CHANNELS.evidenceList, {
        targetId
      })
    );
  });
}

async function installEngine(file: string, args: string[]): Promise<void> {
  const config = loadConfig();
  const expected = option(args, "--sha256");
  const installed = installEngineArtifact(config.workspaceRoot, file, expected);
  printJson(installed);
}

async function compare(
  targetId: string | undefined,
  leftArtifactId: string | undefined,
  rightArtifactId: string | undefined,
  args: string[]
): Promise<void> {
  if (!targetId || !leftArtifactId || !rightArtifactId) {
    throw new CoreFailure(
      "INVALID_INPUT",
      "用法：apptrace compare <target-id> <left-artifact-id> <right-artifact-id>"
    );
  }
  await withCore(async (core) => {
    printJson(
      await new VersionComparisonService(core).compare(
        targetId,
        leftArtifactId,
        rightArtifactId,
        { force: hasFlag(args, "--force") }
      )
    );
  });
}

async function capabilities(targetId?: string): Promise<void> {
  await withCore(async (core) => {
    printJson(
      await core.handle(CHANNELS.capabilitiesList, {
        ...(targetId ? { targetId } : {})
      })
    );
  });
}

async function main(): Promise<void> {
  const [command, subcommand, ...args] = process.argv.slice(2);
  if (!command || ["help", "-h", "--help"].includes(command)) {
    usage();
    return;
  }
  if (command === "setup-worker") {
    if (!subcommand || !/^[0-9a-f-]{36}$/.test(subcommand)) throw new CoreFailure("INVALID_INPUT", "无效的安装操作标识。");
    const config = loadConfig();
    return runInstallation(config, () => installTools(config), subcommand);
  }
  if (command === "setup") {
    const setupArgs =
      subcommand?.startsWith("--") && subcommand
        ? [subcommand, ...args]
        : args;
    return setup(hasFlag(setupArgs, "--json"), setupArgs);
  }
  if (command === "doctor") {
    const doctorArgs =
      subcommand?.startsWith("--") && subcommand
        ? [subcommand, ...args]
        : args;
    return doctor(hasFlag(doctorArgs, "--json"));
  }
  if (command === "auth") {
    if (subcommand === "open") {
      printJson(await new OnboardingService(loadConfig(), __filename).openLogin());
      return;
    }
    if (subcommand === "login") return authLogin();
    if (subcommand === "status") return authStatus();
  }
  if (command === "targets") {
    if (subcommand === "add") {
      const source = positional(args);
      if (!source) throw new CoreFailure("SOURCE_REQUIRED", "缺少应用链接或 ID。");
      return addTarget(source);
    }
    if (subcommand === "list") return listTargets();
  }
  if (command === "analyze") {
    const analyzeArgs =
      subcommand?.startsWith("--") && subcommand
        ? [subcommand, ...args]
        : args;
    const source =
      subcommand && !subcommand.startsWith("--")
        ? subcommand
        : positional(analyzeArgs);
    return analyze(source, analyzeArgs);
  }
  if (command === "report") {
    if (!subcommand) throw new CoreFailure("TARGET_REQUIRED", "缺少 target ID。");
    return report(subcommand);
  }
  if (command === "jobs" && subcommand === "get") {
    const jobId = positional(args);
    if (!jobId) throw new CoreFailure("JOB_REQUIRED", "缺少 job ID。");
    return getJob(jobId);
  }
  if (command === "search") {
    if (!subcommand) throw new CoreFailure("TARGET_REQUIRED", "缺少 target ID。");
    return searchFindings(subcommand, args[0], args);
  }
  if (command === "native") return nativeCommand(subcommand, args);
  if (command === "evidence") {
    if (!subcommand) throw new CoreFailure("TARGET_REQUIRED", "缺少 target ID。");
    return evidence(subcommand);
  }
  if (command === "engine" && subcommand === "install") {
    const file = args[0];
    if (!file) throw new CoreFailure("ENGINE_REQUIRED", "缺少 engine 文件路径。");
    return installEngine(file, args);
  }
  if (command === "compare") {
    if (!subcommand) throw new CoreFailure("TARGET_REQUIRED", "缺少 target ID。");
    return compare(subcommand, args[0], args[1], args);
  }
  if (command === "capabilities") return capabilities(subcommand);
  if (command === "mcp") {
    process.env.APPTRACE_CLI_PATH = __filename;
    const { startMcpServer } = await import("@zhuixin/mcp");
    await startMcpServer(loadConfig());
    return;
  }
  usage();
  throw new CoreFailure("UNKNOWN_COMMAND", `未知命令：${command}`);
}

void main().catch((error) => {
  printError(error);
  process.exitCode = 1;
});
