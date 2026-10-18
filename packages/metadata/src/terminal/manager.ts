import { randomUUID } from "node:crypto";
import { spawn, type IPty } from "node-pty";
import type { CoreEvent } from "@zhuixin/shared";
import { fail } from "../errors.js";

export class TerminalManager {
  private readonly sessions = new Map<string, IPty>();

  constructor(
    private readonly ipatoolPath: string,
    private readonly emit: (event: CoreEvent) => void
  ) {}

  start(kind: "ipatool-auth"): { sessionId: string } {
    if (kind !== "ipatool-auth") {
      fail("UNSUPPORTED_TERMINAL", `未注册的终端类型：${kind}`);
    }

    const sessionId = randomUUID();
    let child: IPty;
    try {
      child = spawn(this.ipatoolPath, ["auth", "login"], {
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
        `无法启动登录终端：${error instanceof Error ? error.message : String(error)}`
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
    if (!child) fail("TERMINAL_NOT_FOUND", "登录终端已经结束。");
    try {
      child.write(data);
    } catch {
      fail("TERMINAL_CLOSED", "登录终端不可写入。");
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
