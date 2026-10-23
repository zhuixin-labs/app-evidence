import fs from "node:fs";
import path from "node:path";
import type { ResolvedTarget } from "@zhuixin/shared";
import { fail } from "../errors.js";
import { descriptor, type ResolveOutput, type SourceProvider } from "./types.js";

function normalizePath(input: string): string {
  const trimmed = input.trim();
  const unquoted =
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
      ? trimmed.slice(1, -1)
      : trimmed;
  return path.resolve(unquoted);
}

function hasExecutable(dir: string): boolean {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .some((entry) => entry.isFile() && /\.exe$/i.test(entry.name));
  } catch {
    return false;
  }
}

/** Squirrel installs keep the program in `app-<version>`, next to a small launcher. */
function squirrelVersions(dir: string): string[] {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && /^app-\d/i.test(entry.name))
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

export function looksLikeWindowsInstall(dir: string): boolean {
  return hasExecutable(dir) || squirrelVersions(dir).some((name) => hasExecutable(path.join(dir, name)));
}

/**
 * Resolves an installed Windows program into a Target. The input is the
 * program's install directory (for example `C:\Program Files\Typora`); nothing
 * is installed, run or copied. The name, version and publisher shown here come
 * from the directory name until inspection reads the executable's own version
 * resource.
 */
export class LocalWindowsAppProvider implements SourceProvider {
  readonly descriptor = descriptor(
    "local-file",
    "windows",
    "Local Windows app",
    false,
    "preview",
    "Installed program directory · read-only"
  );

  canHandle(input: string): boolean {
    try {
      const appPath = normalizePath(input);
      if (appPath.toLowerCase().endsWith(".app")) return false;
      return fs.statSync(appPath).isDirectory() && looksLikeWindowsInstall(appPath);
    } catch {
      return false;
    }
  }

  async resolve(input: string): Promise<ResolveOutput> {
    const sourcePath = normalizePath(input);
    if (!fs.statSync(sourcePath, { throwIfNoEntry: false })?.isDirectory()) {
      fail("UNSUPPORTED_SOURCE", `Not a directory: ${sourcePath}`);
    }
    if (!looksLikeWindowsInstall(sourcePath)) {
      fail(
        "UNSUPPORTED_SOURCE",
        "No .exe was found in this directory. Pass the folder that holds the program's main .exe."
      );
    }
    const name = path.basename(sourcePath) || sourcePath;
    const target: ResolvedTarget = {
      targetRef: { platform: "windows", sourceId: "local-file", sourceRef: sourcePath },
      name,
      metadata: { installPath: sourcePath }
    };
    return { target, raw: { installPath: sourcePath } };
  }
}
