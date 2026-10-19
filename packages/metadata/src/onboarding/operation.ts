import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";

// Preserve the required node: prefix, as in the application store.
const nodeRequire = createRequire(typeof __filename === "string" ? __filename : import.meta.url);
const { DatabaseSync } = nodeRequire(["node", "sqlite"].join(":")) as typeof import("node:sqlite");

export interface Operation {
  token: string;
  pid: number;
  children: number[];
  state: "running" | "completed" | "failed";
  startedAt: string;
  updatedAt: string;
  errorCode?: string;
}

export function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
}
export const operationAlive = (operation: Operation) => [operation.pid, ...operation.children].some(alive);

/** SQLite transactions release on process death; no partially written lock directories. */
export class OperationStore {
  constructor(readonly root: string) { fs.mkdirSync(root, { recursive: true, mode: 0o700 }); }

  private transaction<T>(action: (value: Operation | undefined, save: (value: Operation) => void) => T): T {
    const db = new DatabaseSync(path.join(this.root, "operation.sqlite"));
    try {
      db.exec("PRAGMA busy_timeout = 5000; CREATE TABLE IF NOT EXISTS operation (id INTEGER PRIMARY KEY CHECK (id = 1), payload TEXT NOT NULL)");
      db.exec("BEGIN IMMEDIATE");
      const row = db.prepare("SELECT payload FROM operation WHERE id = 1").get();
      const value = row ? JSON.parse(String(row.payload)) as Operation : undefined;
      const result = action(value, (updated) => {
        db.prepare("INSERT INTO operation(id, payload) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload").run(JSON.stringify(updated));
      });
      db.exec("COMMIT");
      return result;
    } finally { db.close(); }
  }
  current(): Operation | undefined { return this.transaction(value => value?.state === "running" ? value : undefined); }
  last(): Operation | undefined { return this.transaction(value => value?.state !== "running" ? value : undefined); }
  acquire(): Operation | undefined {
    return this.transaction((previous, save) => {
      if (previous?.state === "running" && operationAlive(previous)) return undefined;
      const now = new Date().toISOString();
      const operation: Operation = { token: randomUUID(), pid: process.pid, children: [], state: "running", startedAt: now, updatedAt: now };
      save(operation);
      return operation;
    });
  }
  adopt(token: string, pid: number): void {
    this.transaction((current, save) => {
      if (!current || current.token !== token || current.state !== "running") return;
      save({ ...current, pid, updatedAt: new Date().toISOString() });
    });
  }
  addChild(token: string, pid: number): void {
    this.transaction((current, save) => {
      if (!current || current.token !== token || current.state !== "running") throw new Error("Installation ownership changed");
      save({ ...current, children: [...new Set([...current.children, pid])], updatedAt: new Date().toISOString() });
    });
  }
  finish(token: string, state: "completed" | "failed", errorCode?: string): void {
    this.transaction((current, save) => {
      if (current?.token === token && current.state === "running") save({ ...current, state, errorCode, updatedAt: new Date().toISOString() });
    });
  }
}
