import { randomUUID } from "node:crypto";
import { spawn, type IPty } from "node-pty";
import type { CoreEvent } from "@zhuixin/shared";
import { fail } from "../errors.js";
import type { CoreConfig } from "../config.js";
import { requireBackgroundCredentials } from "../account/ipatool.js";

export class TerminalManager {
  private readonly sessions = new Map<string, IPty>();

  constructor(
    private readonly config: CoreConfig,
    private readonly emit: (event: CoreEvent) => void
  ) {}

  async start(kind: "ipatool-auth"): Promise<{ sessionId: string }> {
    await requireBackgroundCredentials(this.config);
    if (kind !== "ipatool-auth") {
      fail("UNSUPPORTED_TERMINAL", `Unknown terminal type: ${kind}`);
    }

    const sessionId = randomUUID();
    let child: IPty;
    try {
      child = spawn(this.config.ipatoolPath, ["auth", "login"], {
        name: "xterm-256color",
        cols: 100,
        rows: 30,
        cwd: process.cwd(),
        env: {
          ...process.env,
          TERM: "xterm-256color",
          APPTRACE_INTERACTIVE_TERMINAL: "1"
        } as Record<string, string>
      });
    } catch (error) {
      fail(
        "PTY_START_FAILED",
        `Could not start the sign-in terminal: ${error instanceof Error ? error.message : String(error)}`
      );
    }

    this.sessions.set(sessionId, child);
    child.onData((data) => {
      this.emit({
        type: "terminal.data",
        payload: { sessionId, data }
      });
    });
    child.onExit(({ exitCode, signal }) => {
      this.sessions.delete(sessionId);
      this.emit({
        type: "terminal.exit",
        payload: {
          sessionId,
          code: exitCode,
          signal: signal ? String(signal) : null
        }
      });
    });

    return { sessionId };
  }

  input(sessionId: string, data: string): void {
    const child = this.sessions.get(sessionId);
    if (!child) fail("TERMINAL_NOT_FOUND", "The sign-in terminal has exited.");
    try {
      child.write(data);
    } catch {
      fail("TERMINAL_CLOSED", "The sign-in terminal is not writable.");
    }
  }

  stop(sessionId: string): void {
    const child = this.sessions.get(sessionId);
    if (!child) return;
    try {
      child.kill();
    } catch {
      // The PTY may have exited between the lookup and the signal.
    }
    this.sessions.delete(sessionId);
  }

  closeAll(): void {
    for (const child of this.sessions.values()) {
      try {
        child.kill();
      } catch {
        // Ignore already-exited sessions during shutdown.
      }
    }
    this.sessions.clear();
  }
}
