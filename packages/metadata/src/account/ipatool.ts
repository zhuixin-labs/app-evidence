import fs from "node:fs";
import path from "node:path";
import { runCommand, type CommandOptions, type CommandResult } from "../process/run.js";
import type { CoreConfig } from "../config.js";
import { CoreFailure } from "../errors.js";

const supported = new Map<string, number>();

export function managedIpatool(config: CoreConfig): boolean {
  if (config.ipatoolManaged !== undefined) return config.ipatoolManaged;
  if (config.ipatoolPath === "ipatool") return true;
  return ["ipatool.exe", "ipatool-dpapi-v1.exe"].some(name => path.resolve(config.ipatoolPath).toLowerCase() === path.join(config.workspaceRoot, "tools", "ipatool", "bin", name).toLowerCase());
}

export async function requireBackgroundCredentials(config: CoreConfig): Promise<void> {
  if (config.hostPlatform !== "win32") return;
  const mtime = fs.statSync(config.ipatoolPath, { throwIfNoEntry: false })?.mtimeMs;
  if (mtime !== undefined && supported.get(config.ipatoolPath) === mtime) return;
  const version = await runCommand(config.ipatoolPath, ["--version"], { timeoutMs: 5000 });
  if (version.code !== 0 || !version.stdout.includes("apptrace-dpapi-v1")) {
    throw new CoreFailure("IPATOOL_UPDATE_REQUIRED", "Windows requires a DPAPI-enabled ipatool. Run apptrace setup --install; remove an explicit legacy APPTRACE_IPATOOL_PATH/REA_IPATOOL_PATH or point it to the adapter. Original credentials are retained; sign in locally once after upgrading.");
  }
  if (mtime !== undefined) supported.set(config.ipatoolPath, mtime);
}

export async function runIpatool(config: CoreConfig, args: string[], options?: CommandOptions): Promise<CommandResult> {
  await requireBackgroundCredentials(config);
  return runCommand(config.ipatoolPath, args, options);
}

export function credentialFailure(output: string): "locked" | "missing" | "access_failed" | undefined {
  if (/APPTRACE_CREDENTIAL_ACCESS_FAILED/i.test(output)) return "access_failed";
  if (/keychain passphrase is required|keyring passphrase required|keyring.*locked|failed to unlock (?:keychain|keyring)|incorrect passphrase/i.test(output)) return "locked";
  if (/not logged in|not authenticated|no account|not signed in|account.*not found|specified item could not be found/i.test(output)) return "missing";
  return undefined;
}
