import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runCommand } from "../process/run.js";
import { CoreFailure } from "../errors.js";
import { OperationStore, alive } from "./operation.js";

export const loginStore = () => new OperationStore(path.join(os.homedir(), ".apptrace", "login-window"));
const literal = (value: string) => `'${value.replaceAll("'", "''")}'`;
const encoded = (value: string) => Buffer.from(value, "utf16le").toString("base64");

export function loginWindowStatus(): { pending: boolean; exitCode?: number } {
  const store = loginStore();
  const current = store.current();
  if (!current) return { pending: false };
  const result = path.join(store.root, `${current.token}.exit`);
  if (fs.existsSync(result)) {
    const exitCode = Number(fs.readFileSync(result, "utf8").replace(/^\uFEFF/, "").trim());
    store.finish(current.token, exitCode === 0 ? "completed" : "failed", exitCode === 0 ? undefined : "LOGIN_CANCELLED_OR_FAILED");
    return { pending: false, exitCode };
  }
  if (alive(current.pid)) return { pending: true };
  store.finish(current.token, "failed", "LOGIN_WINDOW_CLOSED");
  return { pending: false };
}

/** The helper returns only a PID. The visible terminal inherits no MCP stdio. */
export async function openLoginWindow(ipatool: string): Promise<void> {
  if (process.platform !== "win32") {
    throw new CoreFailure("LOGIN_WINDOW_UNSUPPORTED", "此平台请在本地终端运行 apptrace auth login。");
  }
  if (loginWindowStatus().pending) return;
  const store = loginStore();
  const operation = store.acquire();
  if (!operation) return;
  const result = path.join(store.root, `${operation.token}.exit`);
  const terminal = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const script = [
    "$Host.UI.RawUI.WindowTitle = 'AppTrace - Apple sign in'",
    "Write-Host 'Sign in here. Passwords and verification codes stay in this window.'",
    "$code = 1",
    `try { & ${literal(ipatool)} auth login; $code = $LASTEXITCODE }`,
    `finally { [IO.File]::WriteAllText(${literal(result + ".tmp")}, [string]$code); [IO.File]::Move(${literal(result + ".tmp")}, ${literal(result)}) }`,
    "if ($code -eq 0) { Write-Host 'Sign-in command finished. Return to your agent.' } else { Write-Host 'Sign-in did not complete. Return to your agent to retry.' }",
    "Read-Host 'Press Enter to close' | Out-Null"
  ].join("\n");
  const launch = `$p = Start-Process -FilePath ${literal(terminal)} -ArgumentList @('-NoProfile', '-EncodedCommand', '${encoded(script)}') -WindowStyle Normal -PassThru; $p.Id`;
  try {
    const response = await runCommand(terminal, ["-NoProfile", "-EncodedCommand", encoded(launch)], { timeoutMs: 15_000 });
    const pid = Number(response.stdout.trim());
    if (response.code !== 0 || !Number.isSafeInteger(pid) || pid <= 0) {
      throw new CoreFailure("LOGIN_WINDOW_FAILED", "无法打开登录窗口；请在本地终端运行 apptrace auth login。");
    }
    store.adopt(operation.token, pid);
  } catch (error) {
    store.finish(operation.token, "failed", "LOGIN_WINDOW_FAILED");
    throw error;
  }
}
