import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import readline from "node:readline";
import {
  PROTOCOL_VERSION,
  engineResponseSchema,
  type EngineCapability,
  type EngineRequest,
  type EngineResponse
} from "@zhuixin/protocol";

export class EngineClient {
  private child: ChildProcessWithoutNullStreams | null = null;
  private sequence = 0;
  private readonly pending = new Map<
    string,
    {
      resolve: (value: EngineResponse) => void;
      reject: (error: Error) => void;
      timer: NodeJS.Timeout;
    }
  >();

  constructor(
    private readonly executable: string,
    private readonly childEnv: NodeJS.ProcessEnv = {},
    private readonly onChild?: (child: ChildProcessWithoutNullStreams) => void,
    private readonly timeoutMs = 20 * 60_000
  ) {}

  async start(workspacePath: string): Promise<void> {
    if (this.child) return;
    const spec = this.executable.endsWith(".js")
      ? { command: process.execPath, args: [this.executable, "engine"] }
      : { command: this.executable, args: ["engine"] };
    this.child = spawn(spec.command, spec.args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        ...this.childEnv,
        APPTRACE_WORKSPACE_ROOT: workspacePath
      }
    });
    this.onChild?.(this.child);
    this.child.on("error", (error) => this.failAll(error.message));
    this.child.on("exit", (code) => {
      this.failAll(`Engine exited${code === null ? "" : ` with code ${code}`}`);
    });
    const lines = readline.createInterface({ input: this.child.stdout });
    lines.on("line", (line) => {
      const parsed = engineResponseSchema.safeParse(JSON.parse(line));
      if (!parsed.success) return;
      if (parsed.data.id === "unknown" && !parsed.data.ok) {
        this.failAll(
          parsed.data.error?.message ?? "Engine rejected the request"
        );
        return;
      }
      const entry = this.pending.get(parsed.data.id);
      if (!entry) return;
      clearTimeout(entry.timer);
      this.pending.delete(parsed.data.id);
      entry.resolve(parsed.data);
    });
  }

  private failAll(message: string): void {
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(new Error(message));
    }
    this.pending.clear();
  }

  async execute(
    workspacePath: string,
    capability: EngineCapability,
    input: {
      targetId?: string;
      artifactId?: string;
      values?: Record<string, unknown>;
      license?: { licenseId?: string; features: string[] };
      licenseToken?: string;
    } = {}
  ): Promise<Record<string, unknown>> {
    await this.start(workspacePath);
    const id = `req-${++this.sequence}`;
    const request: EngineRequest = {
      id,
      protocolVersion: PROTOCOL_VERSION,
      operation: "execute",
      capability,
      workspacePath,
      ...(input.targetId ? { targetId: input.targetId } : {}),
      ...(input.artifactId ? { artifactId: input.artifactId } : {}),
      ...(input.values ? { input: input.values } : {}),
      ...(input.license || input.licenseToken
        ? {
            license: {
              ...(input.license ?? { features: [] }),
              ...(input.licenseToken ? { token: input.licenseToken } : {})
            }
          }
        : {})
    };
    return new Promise((resolve, reject) => {
      if (!this.child) return reject(new Error("Engine is not running"));
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Engine request timed out after ${this.timeoutMs}ms`));
      }, this.timeoutMs);
      this.pending.set(id, {
        timer,
        reject,
        resolve: (response) => {
          if (!response.ok || !response.result) {
            reject(new Error(response.error?.message ?? "Engine request failed"));
            return;
          }
          resolve(response.result);
        }
      });
      this.child.stdin.write(`${JSON.stringify(request)}\n`);
    });
  }

  close(): void {
    this.child?.kill("SIGTERM");
    this.child = null;
    this.failAll("Engine client closed");
  }
}
