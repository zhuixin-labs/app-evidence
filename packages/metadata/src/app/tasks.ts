import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { alive } from "../onboarding/operation.js";
import type { AnalysisGoal } from "./analysis.js";
import type { SetupStatus } from "../onboarding/service.js";

const nodeRequire = createRequire(typeof __filename === "string" ? __filename : import.meta.url);
const { DatabaseSync } = nodeRequire(["node", "sqlite"].join(":")) as typeof import("node:sqlite");

export interface TaskArguments {
  source?: string;
  target_id?: string;
  goals?: AnalysisGoal[];
  force?: boolean;
  timeout_seconds?: number;
}
export interface AnalysisTask {
  id: string;
  arguments: TaskArguments;
  status: "queued" | "preparing" | "awaiting_auth" | "running" | "completed" | "failed" | "cancelled";
  stage: string;
  targetId?: string;
  startedAt: string;
  updatedAt: string;
  finishedAt?: string;
  setup?: SetupStatus;
  loginAttempted?: boolean;
  result?: Record<string, unknown>;
  error?: { code: string; message: string };
  owner?: { token: string; pid: number; heartbeat: number; children: number[] };
}
export const terminalTask = (task: AnalysisTask) => ["completed", "failed", "cancelled"].includes(task.status);

/** Separate from evidence storage: all queue mutations are fenced SQLite transactions. */
export class AnalysisTasks {
  readonly filename: string;
  constructor(root: string) {
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    this.filename = path.join(root, "analysis-tasks.sqlite");
    this.transaction(() => {});
  }
  private transaction<T>(action: (db: InstanceType<typeof DatabaseSync>) => T): T {
    const db = new DatabaseSync(this.filename);
    try {
      db.exec("PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, request_key TEXT NOT NULL, payload TEXT NOT NULL)");
      db.exec("BEGIN IMMEDIATE");
      const result = action(db);
      db.exec("COMMIT");
      return result;
    } finally { db.close(); }
  }
  private decode(row: Record<string, unknown> | undefined): AnalysisTask | undefined {
    return row ? JSON.parse(String(row.payload)) as AnalysisTask : undefined;
  }
  get(id: string): AnalysisTask | undefined {
    return this.transaction(db => this.decode(db.prepare("SELECT payload FROM tasks WHERE id=?").get(id)));
  }
  list(): AnalysisTask[] {
    return this.transaction(db => db.prepare("SELECT payload FROM tasks").all().map(row => this.decode(row)!));
  }
  create(input: TaskArguments): AnalysisTask {
    const args: TaskArguments = { source: input.source?.trim(), target_id: input.target_id, goals: [...new Set(input.goals?.length ? input.goals : ["tech_stack", "feature_map", "report"] as AnalysisGoal[])].sort(), force: input.force ?? false, timeout_seconds: input.timeout_seconds ?? 1200 };
    const key = createHash("sha256").update(JSON.stringify(args)).digest("hex");
    return this.transaction(db => {
      const previous = db.prepare("SELECT payload FROM tasks WHERE request_key=?").all(key).map(row => this.decode(row)!).find(task => !terminalTask(task));
      if (previous) return previous;
      const now = new Date().toISOString();
      const task: AnalysisTask = { id: randomUUID(), arguments: args, status: "queued", stage: "queued", startedAt: now, updatedAt: now };
      db.prepare("INSERT INTO tasks VALUES (?, ?, ?)").run(task.id, key, JSON.stringify(task));
      return task;
    });
  }
  claim(id: string): string | undefined {
    return this.transaction(db => {
      const task = this.decode(db.prepare("SELECT payload FROM tasks WHERE id=?").get(id));
      if (!task || terminalTask(task)) return;
      // A stale heartbeat alone is not permission to overlap a live worker or
      // orphaned download. PID reuse conservatively delays recovery, never duplicates it.
      if (task.owner && (Date.now() - task.owner.heartbeat < 15000 || [task.owner.pid, ...task.owner.children].some(alive))) return;
      const token = randomUUID();
      task.owner = { token, pid: process.pid, heartbeat: Date.now(), children: [] };
      task.updatedAt = new Date().toISOString();
      db.prepare("UPDATE tasks SET payload=? WHERE id=?").run(JSON.stringify(task), id);
      return token;
    });
  }
  update(id: string, token: string, patch: Partial<Omit<AnalysisTask, "id" | "arguments" | "owner">>, child?: { pid: number; active: boolean }): boolean {
    return this.transaction(db => {
      const task = this.decode(db.prepare("SELECT payload FROM tasks WHERE id=?").get(id));
      if (!task || task.owner?.token !== token || terminalTask(task)) return false;
      Object.assign(task, patch);
      task.updatedAt = new Date().toISOString();
      task.owner.heartbeat = Date.now();
      if (child) task.owner.children = child.active ? [...new Set([...task.owner.children, child.pid])] : task.owner.children.filter(pid => pid !== child.pid);
      db.prepare("UPDATE tasks SET payload=? WHERE id=?").run(JSON.stringify(task), id);
      return true;
    });
  }
  release(id: string, token: string): void {
    this.transaction(db => {
      const task = this.decode(db.prepare("SELECT payload FROM tasks WHERE id=?").get(id));
      if (!task || task.owner?.token !== token) return;
      task.owner = undefined;
      db.prepare("UPDATE tasks SET payload=? WHERE id=?").run(JSON.stringify(task), id);
    });
  }
  cancel(id: string): AnalysisTask | undefined {
    return this.transaction(db => {
      const task = this.decode(db.prepare("SELECT payload FROM tasks WHERE id=?").get(id));
      if (!task || terminalTask(task)) return task;
      task.status = "cancelled";
      task.finishedAt = task.updatedAt = new Date().toISOString();
      db.prepare("UPDATE tasks SET payload=? WHERE id=?").run(JSON.stringify(task), id);
      return task;
    });
  }
}
