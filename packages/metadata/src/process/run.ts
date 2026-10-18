import { spawn, type ChildProcessByStdio } from "node:child_process";
import path from "node:path";
import type { Readable } from "node:stream";

export interface CommandResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export interface CommandOptions {
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  signal?: AbortSignal;
}

function quoteWindowsArgument(value: string): string {
  if (value.length === 0) return '""';
  if (!/[\s"&|<>^()%!]/.test(value)) return value;
  return `"${value.replace(/"/g, '""').replace(/%/g, "%%")}"`;
}

export function windowsCommandLine(command: string, args: string[]): string {
  return [command, ...args].map(quoteWindowsArgument).join(" ");
}

function windowsSpawnSpec(
  command: string,
  args: string[]
): { command: string; args: string[]; verbatim: boolean } {
  const extension = path.extname(command).toLowerCase();
  if (extension !== ".cmd" && extension !== ".bat") {
    return { command, args, verbatim: false };
  }
  const comspec = process.env.ComSpec || process.env.COMSPEC || "cmd.exe";
  const line = windowsCommandLine(command, args);
  return {
    command: comspec,
    args: ["/d", "/s", "/c", `"${line}"`],
    verbatim: true
  };
}

export function runCommand(
  command: string,
  args: string[],
  options: CommandOptions = {}
): Promise<CommandResult> {
  const timeoutMs = options.timeoutMs ?? 60_000;
  return new Promise((resolve) => {
    let child: ChildProcessByStdio<null, Readable, Readable>;
    try {
      const spec =
        process.platform === "win32"
          ? windowsSpawnSpec(command, args)
          : { command, args, verbatim: false };
      child = spawn(spec.command, spec.args, {
        env: options.env ?? process.env,
        cwd: options.cwd,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
        windowsVerbatimArguments: spec.verbatim,
        signal: options.signal
      });
    } catch (error) {
      resolve({
        code: null,
        stdout: "",
        stderr: error instanceof Error ? error.message : String(error),
        timedOut: false
      });
      return;
    }

    const stdout: string[] = [];
    const stderr: string[] = [];
    let timedOut = false;
    let settled = false;
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk.toString("utf8")));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk.toString("utf8")));
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, timeoutMs);
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        code: null,
        stdout: stdout.join(""),
        stderr: `${stderr.join("")}\n${error.message}`.trim(),
        timedOut
      });
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        code,
        stdout: stdout.join(""),
        stderr: stderr.join(""),
        timedOut
      });
    });
  });
}
