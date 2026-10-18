import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface CoreConfig {
  workspaceRoot: string;
  ipatoolPath: string;
  enginePath: string;
  licenseToken?: string;
  hostPlatform: NodeJS.Platform;
}

export function loadConfig(
  env: NodeJS.ProcessEnv = process.env,
  hostPlatform: NodeJS.Platform = process.platform
): CoreConfig {
  const workspaceRoot =
    env.APPTRACE_WORKSPACE_ROOT ||
    env.REA_WORKSPACE_ROOT ||
    defaultWorkspaceRoot(hostPlatform, env);

  const cwd = process.cwd();
  const legacyRoot = path.resolve(cwd, "..");
  const resolvedWorkspaceRoot = path.resolve(workspaceRoot);
  const workspaceTools = path.join(resolvedWorkspaceRoot, "tools");
  const ipatoolName = hostPlatform === "win32" ? "ipatool.exe" : "ipatool";
  return {
    workspaceRoot: resolvedWorkspaceRoot,
    ipatoolPath:
      firstExisting([
        env.APPTRACE_IPATOOL_PATH,
        env.REA_IPATOOL_PATH,
        path.join(workspaceTools, "ipatool", "bin", ipatoolName),
        path.join(cwd, "tools", "ipatool", "bin", ipatoolName),
        path.join(legacyRoot, "tools", "ipatool", "bin", ipatoolName)
      ]) || "ipatool",
    enginePath:
      env.APPTRACE_ENGINE_PATH ||
      firstExisting([
        path.join(cwd, "apptrace-engine", "dist", "engine-main.js"),
        path.join(legacyRoot, "apptrace-private", "packages", "engine", "dist", "engine-main.js")
      ]) ||
      path.resolve(cwd, "apptrace-engine/dist/engine-main.js"),
    licenseToken: env.APPTRACE_LICENSE,
    hostPlatform
  };
}

function firstExisting(candidates: Array<string | undefined>): string | undefined {
  for (const candidate of candidates) {
    if (!candidate) continue;
    if (!path.isAbsolute(candidate)) return candidate;
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch {
      // Continue through other candidates.
    }
  }
  return undefined;
}

function defaultWorkspaceRoot(
  hostPlatform: NodeJS.Platform,
  env: NodeJS.ProcessEnv
): string {
  if (hostPlatform === "darwin") {
    return path.join(
      os.homedir(),
      "Library",
      "Application Support",
      "AppTrace",
      "workspace"
    );
  }
  if (hostPlatform === "win32") {
    return path.join(
      env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"),
      "AppTrace",
      "workspace"
    );
  }
  return path.join(
    env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share"),
    "apptrace",
    "workspace"
  );
}
