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
  private readonly pending = new Map<string, (value: EngineResponse) => void>();

  constructor(
    private readonly executable: string,
    private readonly childEnv: NodeJS.ProcessEnv = {}
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
    const lines = readline.createInterface({ input: this.child.stdout });
    lines.on("line", (line) => {
      const parsed = engineResponseSchema.safeParse(JSON.parse(line));
      if (!parsed.success) return;
      this.pending.get(parsed.data.id)?.(parsed.data);
      this.pending.delete(parsed.data.id);
    });
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
      this.pending.set(id, (response) => {
        if (!response.ok || !response.result) {
          reject(new Error(response.error?.message ?? "Engine request failed"));
          return;
        }
        resolve(response.result);
      });
      this.child.stdin.write(`${JSON.stringify(request)}\n`);
    });
  }

  close(): void {
    this.child?.kill("SIGTERM");
    this.child = null;
    this.pending.clear();
  }
}
