import fs from "node:fs";
import path from "node:path";

/** Resolve commands without launching a shell or treating a bare name as installed. */
export function resolveTool(value: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (!value) return undefined;
  const explicit = path.isAbsolute(value) || /[\\/]/.test(value);
  const directories = explicit ? [""] : (env.PATH ?? env.Path ?? "").split(path.delimiter);
  const extensions = process.platform === "win32" && !path.extname(value)
    ? (env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";")
    : [""];
  for (const directory of directories) {
    for (const extension of extensions) {
      const candidate = path.resolve(directory.replace(/^"|"$/g, ""), value + extension);
      try {
        if (!fs.statSync(candidate).isFile()) continue;
        if (process.platform !== "win32") fs.accessSync(candidate, fs.constants.X_OK);
        return candidate;
      } catch { /* Try the next PATH entry. */ }
    }
  }
  return undefined;
}
