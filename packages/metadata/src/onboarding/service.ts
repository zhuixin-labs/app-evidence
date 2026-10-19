import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { loadConfig, type CoreConfig } from "../config.js";
import { resolveTool } from "../tools.js";
import { AccountService } from "../account/service.js";
import { CoreFailure } from "../errors.js";
import { operationAlive, OperationStore } from "./operation.js";
import { loginWindowStatus, openLoginWindow } from "./login-window.js";

export interface SetupStatus {
  state: "tools_missing" | "installing" | "login_required" | "keychain_locked" | "login_pending" | "ready" | "failed";
  message: string;
  missingTools?: string[];
  phase?: string;
  updatedAt: string;
  errorCode?: string;
  logPath?: string;
  next_tool?: "prepare_environment" | "get_setup_status" | "open_login";
}

export const installStore = (config: CoreConfig) => new OperationStore(path.join(config.workspaceRoot, ".onboarding", "install"));
export function trackInstallationChild(config: CoreConfig, pid: number): void {
  const store = installStore(config);
  const operation = store.current();
  if (operation?.pid === process.pid) store.addChild(operation.token, pid);
}

/** Same lock for interactive CLI setup and the detached MCP installation worker. */
export async function runInstallation(config: CoreConfig, install: () => Promise<void>, token?: string): Promise<void> {
  const store = installStore(config);
  const operation = token ? store.current() : store.acquire();
  if (!operation || (token && operation.token !== token)) throw new CoreFailure("SETUP_BUSY", "Environment setup is already running; query the setup status.");
  store.adopt(operation.token, process.pid);
  try {
    await install();
    store.finish(operation.token, "completed");
  } catch (error) {
    store.finish(operation.token, "failed", error instanceof CoreFailure ? error.code : "SETUP_FAILED");
    throw error;
  }
}

export function missingSetupTools(config: CoreConfig): string[] {
    const tools = path.join(config.workspaceRoot, "tools");
    const managed = path.resolve(config.analysisEnginePath) === path.join(tools, "bin", process.platform === "win32" ? "rea.cmd" : "rea");
    return [
      ...(!fs.statSync(config.enginePath, { throwIfNoEntry: false })?.isFile() ? ["analysis_engine"] : []),
      ...(!resolveTool(config.ipatoolPath) ? ["ipatool"] : []),
      ...(!resolveTool(config.analysisEnginePath) ? ["rea"] : []),
      ...(managed && !fs.existsSync(path.join(tools, "jdk", "bin", process.platform === "win32" ? "java.exe" : "java")) ? ["java"] : []),
      ...(managed && !fs.existsSync(path.join(tools, "ghidra_12.1.4_PUBLIC", "support", process.platform === "win32" ? "analyzeHeadless.bat" : "analyzeHeadless")) ? ["ghidra"] : [])
    ];
  }


export class OnboardingService {
  constructor(private readonly config: CoreConfig, private readonly cliPath = process.env.APPTRACE_CLI_PATH) {}

  private environment(): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { ...process.env, APPTRACE_WORKSPACE_ROOT: this.config.workspaceRoot };
    // Old setup versions wrote these unresolved default names into MCP config.
    if (env.APPTRACE_IPATOOL_PATH === "ipatool" && !resolveTool("ipatool")) delete env.APPTRACE_IPATOOL_PATH;
    if (env.APPTRACE_ANALYSIS_ENGINE_PATH === "rea" && !resolveTool("rea")) delete env.APPTRACE_ANALYSIS_ENGINE_PATH;
    return env;
  }

  private refresh(): void {
    Object.assign(this.config, loadConfig(this.environment(), this.config.hostPlatform));
  }


  async status(requireAccount = true, timeoutMs = 5_000): Promise<SetupStatus> {
    this.refresh();
    const updatedAt = new Date().toISOString();
    const store = installStore(this.config);
    const current = store.current();
    const logPath = current ? path.join(store.root, `${current.token}.log`) : undefined;
    if (current && operationAlive(current)) {
      let phase = "installing_tools";
      if (logPath && fs.existsSync(logPath)) {
        const file = fs.openSync(logPath, "r");
        try {
          const size = fs.fstatSync(file).size;
          const tail = Buffer.alloc(Math.min(size, 8192));
          fs.readSync(file, tail, 0, tail.length, size - tail.length);
          const downloads = [...tail.toString().matchAll(/Downloading[^\r\n]+/g)];
          const latest = downloads.at(-1)?.[0] ?? "";
          phase = /ipatool/.test(latest) ? "installing_ipatool" : /jdk|temurin/i.test(latest) ? "installing_java" : /ghidra/i.test(latest) ? "installing_ghidra" : phase;
        } finally { fs.closeSync(file); }
      }
      return { state: "installing", message: "Preparing the analysis environment; no command needed from the user.", updatedAt, phase, logPath, next_tool: "get_setup_status" };
    }
    const missingTools = missingSetupTools(this.config);
    if (missingTools.length) {
      const last = store.last();
      if (current || last?.state === "failed") {
        return { state: "failed", message: "Environment setup failed or was interrupted. Check the install log, then retry with prepare_environment(retry=true).", updatedAt, missingTools, errorCode: current ? "PROCESS_INTERRUPTED" : last?.errorCode, logPath: path.join(store.root, `${current?.token ?? last?.token}.log`), next_tool: "prepare_environment" };
      }
      return { state: "tools_missing", message: "Analysis tools are missing; the agent can install them automatically.", missingTools, updatedAt, next_tool: "prepare_environment" };
    }
    if (!requireAccount) return { state: "ready", message: "Local analysis tools are ready.", updatedAt };
    const account = await new AccountService(this.config).status(true, timeoutMs);
    if (account.authenticated) return { state: "ready", message: "Environment and Apple sign-in are ready; resume the original analysis.", updatedAt };
    if (loginWindowStatus().pending) return { state: "login_pending", message: "Enter your account, password or verification code in the open AppTrace sign-in window; the agent resumes when done.", updatedAt, next_tool: "get_setup_status" };
    if (account.errorCode) return { state: "failed", message: account.message ?? "Account status check failed.", errorCode: account.errorCode, updatedAt, next_tool: "get_setup_status" };
    return { state: account.keychain === "locked" ? "keychain_locked" : "login_required", message: "The user must sign in or unlock locally; the agent can open the window.", updatedAt, next_tool: "open_login" };
  }

  async prepare(retry = false): Promise<SetupStatus> {
    const status = await this.status(false);
    if (status.state === "installing") return status;
    if (status.state === "ready") return status;
    if (status.state === "failed" && !retry) return status;
    if (!this.cliPath || !fs.existsSync(this.cliPath)) {
      throw new CoreFailure("SETUP_ENTRY_MISSING", "Run apptrace setup --write-config <client config path> through the agent, then reload MCP.");
    }
    const store = installStore(this.config);
    const operation = store.acquire();
    if (!operation) return { state: "installing", message: "Another setup request is starting.", updatedAt: new Date().toISOString(), next_tool: "get_setup_status" };
    let output: number | undefined;
    try {
      output = fs.openSync(path.join(store.root, `${operation.token}.log`), "a", 0o600);
      const env = this.environment();
      const child = spawn(process.execPath, [this.cliPath, "setup-worker", operation.token], { env, detached: true, windowsHide: true, stdio: ["ignore", output, output] });
      await new Promise<void>((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });
      if (store.current()?.token === operation.token) store.adopt(operation.token, child.pid!);
      child.unref();
    } catch (error) {
      store.finish(operation.token, "failed", "SETUP_START_FAILED");
      throw error;
    } finally { if (output !== undefined) fs.closeSync(output); }
    return { state: "installing", message: "Environment preparation started.", updatedAt: new Date().toISOString(), next_tool: "get_setup_status" };
  }

  async openLogin(): Promise<SetupStatus> {
    const status = await this.status();
    if (status.state === "ready" || status.state === "login_pending") return status;
    if (status.state !== "login_required" && status.state !== "keychain_locked") return status;
    const executable = resolveTool(this.config.ipatoolPath);
    if (!executable) return this.status();
    await openLoginWindow(executable);
    return { state: "login_pending", message: "A local Apple sign-in window is open. Enter credentials only there; the agent checks status and resumes.", updatedAt: new Date().toISOString(), next_tool: "get_setup_status" };
  }
}
