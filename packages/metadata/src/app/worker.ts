import fs from "node:fs";
import { spawn } from "node:child_process";
import type { CoreConfig } from "../config.js";
import { CoreServer } from "../server.js";
import { CoreFailure } from "../errors.js";
import { OnboardingService } from "../onboarding/service.js";
import { observeChildren } from "../process/children.js";
import { AppAnalysisService } from "./analysis.js";
import { AnalysisTasks, terminalTask } from "./tasks.js";
import { managedIpatool } from "../account/ipatool.js";

const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

export async function startAnalysisWorker(config: CoreConfig, id: string, cliPath = process.env.APPTRACE_CLI_PATH): Promise<void> {
  const task = new AnalysisTasks(config.workspaceRoot).get(id);
  if (!task || terminalTask(task) || task.owner && (Date.now() - task.owner.heartbeat < 15000)) return;
  if (!cliPath || !fs.existsSync(cliPath)) throw new CoreFailure("WORKER_ENTRY_MISSING", "需要通过 apptrace mcp 启动客户端，才能在登录后自动继续任务。");
  const env: NodeJS.ProcessEnv = { ...process.env, APPTRACE_WORKSPACE_ROOT: config.workspaceRoot, APPTRACE_IPATOOL_PATH: config.ipatoolPath, APPTRACE_ENGINE_PATH: config.enginePath, APPTRACE_ANALYSIS_ENGINE_PATH: config.analysisEnginePath };
  // An automatically discovered path must not become an explicit custom
  // override in the child; otherwise legacy tool upgrades stop at this boundary.
  if (managedIpatool(config)) {
    delete env.APPTRACE_IPATOOL_PATH;
    delete env.REA_IPATOOL_PATH;
  }
  const child = spawn(process.execPath, [cliPath, "analysis-worker", id], {
    detached: true, windowsHide: true, stdio: "ignore",
    env
  });
  await new Promise<void>((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });
  child.unref();
}

/** Runs outside MCP. No credentials or terminal output cross the task database. */
export async function runAnalysisWorker(config: CoreConfig, id: string, cliPath: string): Promise<void> {
  const tasks = new AnalysisTasks(config.workspaceRoot);
  const token = tasks.claim(id);
  if (!token) return;
  const initial = tasks.get(id)!;
  const onboarding = new OnboardingService(config, cliPath);
  let core: CoreServer | undefined;
  let cancelled = false;
  const children = new Set<number>();
  const stopChildren = () => {
    for (const pid of children) {
      if (process.platform === "win32") {
        const killer = spawn("taskkill.exe", ["/PID", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
        killer.on("error", () => {});
      } else { try { process.kill(pid, "SIGTERM"); } catch {} }
    }
  };
  const controller = new AbortController();
  const update = (patch: Parameters<AnalysisTasks["update"]>[2]) => tasks.update(id, token, patch);
  observeChildren((pid, active) => {
    if (active) children.add(pid); else children.delete(pid);
    tasks.update(id, token, {}, { pid, active });
  });
  const heartbeat = setInterval(() => {
    if (!update({})) { cancelled = true; stopChildren(); controller.abort(); }
  }, 2000);
  // User waits may be long. After 30 idle minutes release the worker, retaining
  // the request. A new MCP session or explicit login restarts waiting workers.
  const idleDeadline = Date.now() + 30 * 60_000;
  try {
    if (!update({ status: "preparing", stage: "environment" })) return;
    while (!cancelled) {
      const tools = await onboarding.status(false);
      if (tools.state === "ready") break;
      if (tools.state === "tools_missing") {
        const setup = await onboarding.prepare();
        update({ setup, status: "preparing", stage: "environment" });
      } else if (tools.state === "failed") {
        throw new CoreFailure(tools.errorCode ?? "SETUP_FAILED", tools.message);
      } else update({ setup: tools });
      if (Date.now() >= idleDeadline) return;
      await pause(2000);
    }
    if (cancelled) return;
    core = new CoreServer({ config, emit: () => {} });
    const analysis = new AppAnalysisService(core);
    const prepared = await analysis.prepareTarget({ source: initial.arguments.source, targetId: initial.arguments.target_id });
    update({ targetId: prepared.targetId });
    if (prepared.requiresAccount) {
      while (!cancelled) {
        let setup = await onboarding.status(true);
        if (setup.state === "ready") break;
        const current = tasks.get(id)!;
        if (!current.loginAttempted && ["login_required", "keychain_locked"].includes(setup.state)) {
          update({ loginAttempted: true });
          if (config.hostPlatform === "win32") setup = await onboarding.openLogin();
        }
        if (config.hostPlatform !== "win32" && setup.state === "login_required") {
          setup = { ...setup, message: "请在本地终端运行 apptrace auth login；后台验证成功后保存的任务会自动继续。" };
        }
        update({ status: "awaiting_auth", stage: setup.errorCode === "LOGIN_CANCELLED_OR_FAILED" ? "login_cancelled" : "authentication", setup });
        if (setup.errorCode === "CREDENTIAL_ACCESS_FAILED" || setup.errorCode === "IPATOOL_UPDATE_REQUIRED") throw new CoreFailure(setup.errorCode, setup.message);
        if (Date.now() >= idleDeadline) return;
        await pause(2000);
      }
    }
    if (cancelled || !update({ status: "running", stage: "analysis", setup: undefined, error: undefined })) return;
    const result = await analysis.analyzeApp({
      source: initial.arguments.source, targetId: prepared.targetId, goals: initial.arguments.goals,
      force: initial.arguments.force, timeoutMs: (initial.arguments.timeout_seconds ?? 1200) * 1000,
      signal: controller.signal,
      onProgress: event => {
        if (!update({ stage: event.step })) throw new CoreFailure("TASK_CANCELLED", "分析任务已取消。");
      }
    });
    update({ status: "completed", stage: "completed", result: result as unknown as Record<string, unknown>, finishedAt: new Date().toISOString() });
  } catch (error) {
    const failure = error instanceof CoreFailure ? error : new CoreFailure("ANALYSIS_FAILED", "分析 Worker 失败；任务与已有产物已保留。");
    update({ status: "failed", stage: "failed", error: { code: failure.code, message: failure.message }, finishedAt: new Date().toISOString() });
  } finally {
    clearInterval(heartbeat);
    stopChildren();
    observeChildren();
    core?.close();
    tasks.release(id, token);
  }
}

export async function recoverAnalysisTasks(config: CoreConfig, cliPath = process.env.APPTRACE_CLI_PATH): Promise<void> {
  if (!cliPath) return;
  const tasks = new AnalysisTasks(config.workspaceRoot);
  for (const task of tasks.list()) {
    if (!terminalTask(task) && (!task.owner || Date.now() - task.owner.heartbeat > 15000)) await startAnalysisWorker(config, task.id, cliPath);
  }
}
