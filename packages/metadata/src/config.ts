import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { resolveTool } from "./tools.js";

const requireFromHere = createRequire(__filename);

/**
 * The engine ships as a normal npm dependency of the CLI, so a global install
 * needs no separate download step. An explicit path or a workspace install
 * still wins, which keeps offline and pinned deployments possible.
 */
function packagedEnginePath(): string | undefined {
  try {
    return requireFromHere.resolve("@zhuixin/engine/engine-main.js");
  } catch {
    return undefined;
  }
}

export interface CoreConfig {
  workspaceRoot: string;
  ipatoolPath: string;
  enginePath: string;
  analysisEnginePath: string;
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
  const reaName = hostPlatform === "win32" ? "rea.cmd" : "rea";
  const ipatoolName = hostPlatform === "win32" ? "ipatool.exe" : "ipatool";
  return {
    workspaceRoot: resolvedWorkspaceRoot,
    ipatoolPath:
      env.APPTRACE_IPATOOL_PATH || env.REA_IPATOOL_PATH ||
      firstExisting([
        path.join(workspaceTools, "ipatool", "bin", ipatoolName),
        path.join(cwd, "tools", "ipatool", "bin", ipatoolName),
        path.join(legacyRoot, "tools", "ipatool", "bin", ipatoolName)
      ]) || "ipatool",
    enginePath:
      env.APPTRACE_ENGINE_PATH ||
      firstExisting([
        path.join(workspaceTools, "engine", "current", "engine-main.js"),
        path.join(cwd, "apptrace-engine", "dist", "engine-main.js")
      ]) ||
      packagedEnginePath() ||
      path.resolve(cwd, "apptrace-engine/dist/engine-main.js"),
    analysisEnginePath:
      env.APPTRACE_ANALYSIS_ENGINE_PATH || env.APPTRACE_REA_PATH || env.REA_PATH ||
      firstExisting([
        path.join(workspaceTools, "bin", reaName),
        path.join(cwd, reaName),
        path.join(legacyRoot, reaName)
      ]) || resolveTool("rea", env) || "rea",
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
