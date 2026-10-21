import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { AnalysisTasks } from "../src/app/tasks.js";
import { runAnalysisWorker, startAnalysisWorker } from "../src/app/worker.js";
import { OnboardingService } from "../src/onboarding/service.js";
import { AppAnalysisService } from "../src/app/analysis.js";
import { loadConfig } from "../src/config.js";
import { DatabaseSync } from "node:sqlite";

const roots: string[] = [];
function queue() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "apptrace tasks "));
  roots.push(root);
  return new AnalysisTasks(root);
}
afterEach(() => {
  vi.useRealTimers(); vi.restoreAllMocks();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

test("persistent requests deduplicate while active and only one owner may commit", () => {
  const tasks = queue();
  const task = tasks.create({ source: "123", goals: ["report"], timeout_seconds: 600 });
  const reopened = new AnalysisTasks(path.dirname(tasks.filename));
  expect(reopened.create({ source: "123", goals: ["report"], timeout_seconds: 600 }).id).toBe(task.id);
  const token = tasks.claim(task.id)!;
  expect(reopened.claim(task.id)).toBeUndefined();
  expect(tasks.update(task.id, "stale-token", { status: "completed" })).toBe(false);
  expect(tasks.update(task.id, token, { status: "completed", result: { done: true } })).toBe(true);
  expect(reopened.get(task.id)?.result).toEqual({ done: true });
  expect(tasks.create(task.arguments).id).not.toBe(task.id);
});

test("release permits recovery and an orphan child prevents overlapping execution", () => {
  const tasks = queue();
  const task = tasks.create({ source: "123" });
  const token = tasks.claim(task.id)!;
  tasks.release(task.id, "wrong-token");
  expect(tasks.claim(task.id)).toBeUndefined();
  tasks.release(task.id, token);
  const newer = tasks.claim(task.id)!;
  const abandoned = tasks.get(task.id)!;
  abandoned.owner = { token: newer, pid: 2147483647, heartbeat: Date.now() - 20000, children: [process.pid] };
  const db = new DatabaseSync(tasks.filename);
  try {
    db.prepare("UPDATE tasks SET payload=? WHERE id=?").run(JSON.stringify(abandoned), task.id);
    expect(tasks.claim(task.id)).toBeUndefined();
    abandoned.owner.children = [];
    db.prepare("UPDATE tasks SET payload=? WHERE id=?").run(JSON.stringify(abandoned), task.id);
    expect(tasks.claim(task.id)).toBeTruthy();
    expect(tasks.update(task.id, newer, { status: "completed" })).toBe(false);
  } finally { db.close(); }
});

test("cancelling while waiting stops the worker and retains the original task", async () => {
  vi.useFakeTimers();
  const tasks = queue();
  const task = tasks.create({ source: "123", goals: ["report"] });
  const config = loadConfig({ APPTRACE_WORKSPACE_ROOT: path.dirname(tasks.filename) }, "linux");
  vi.spyOn(OnboardingService.prototype, "status").mockImplementation(async (requireAccount = true) => ({ state: requireAccount ? "login_pending" : "ready", message: "controlled wait", updatedAt: new Date().toISOString() }));
  vi.spyOn(AppAnalysisService.prototype, "prepareTarget").mockResolvedValue({ targetId: "target", requiresAccount: true });
  const analyze = vi.spyOn(AppAnalysisService.prototype, "analyzeApp");
  const worker = runAnalysisWorker(config, task.id, "unused-cli");
  await vi.advanceTimersByTimeAsync(2000);
  tasks.cancel(task.id);
  await vi.advanceTimersByTimeAsync(2000);
  await worker;
  expect(analyze).not.toHaveBeenCalled();
  expect(tasks.get(task.id)).toMatchObject({ status: "cancelled", arguments: { source: "123" } });
  expect(tasks.get(task.id)?.owner).toBeUndefined();
});

test("cancelled tasks retain arguments and cannot be resurrected by an old owner", () => {
  const tasks = queue();
  const task = tasks.create({ source: "123", force: true });
  const token = tasks.claim(task.id)!;
  tasks.cancel(task.id);
  expect(tasks.update(task.id, token, { status: "completed" })).toBe(false);
  expect(tasks.claim(task.id)).toBeUndefined();
  expect(tasks.get(task.id)).toMatchObject({ status: "cancelled", arguments: { source: "123", force: true } });
});

test.each(["linux", "win32"] as const)("%s worker waits through login cancellation then resumes the original request once authenticated", async (platform) => {
  vi.useFakeTimers();
  const tasks = queue();
  const task = tasks.create({ source: "123", goals: ["report"], force: true });
  const config = loadConfig({ APPTRACE_WORKSPACE_ROOT: path.dirname(tasks.filename) }, platform);
  let authenticated = false;
  const open = vi.spyOn(OnboardingService.prototype, "openLogin").mockResolvedValue({ state: "login_required", errorCode: "LOGIN_CANCELLED_OR_FAILED", message: "controlled cancellation", updatedAt: new Date().toISOString() });
  vi.spyOn(OnboardingService.prototype, "status").mockImplementation(async (requireAccount = true) => ({
    state: !requireAccount || authenticated ? "ready" : "login_required",
    errorCode: !requireAccount || authenticated ? undefined : "LOGIN_CANCELLED_OR_FAILED",
    message: "controlled status", updatedAt: new Date().toISOString()
  }));
  vi.spyOn(AppAnalysisService.prototype, "prepareTarget").mockResolvedValue({ targetId: "target", requiresAccount: true });
  const analyze = vi.spyOn(AppAnalysisService.prototype, "analyzeApp").mockResolvedValue({ targetId: "target" } as never);
  const worker = runAnalysisWorker(config, task.id, "unused-cli");
  await vi.advanceTimersByTimeAsync(4000);
  const waiting = tasks.get(task.id);
  const opened = open.mock.calls.length;
  const analyzed = analyze.mock.calls.length;
  authenticated = true;
  await vi.advanceTimersByTimeAsync(2000);
  await worker;
  expect(waiting).toMatchObject({ status: "awaiting_auth", stage: "login_cancelled" });
  expect(analyzed).toBe(0);
  expect(opened).toBe(0);
  expect(tasks.get(task.id)?.status).toBe("completed");
  expect(analyze).toHaveBeenCalledTimes(1);
  expect(analyze).toHaveBeenCalledWith(expect.objectContaining({ source: "123", goals: ["report"], force: true }));
});

test.each(["AUTH_CHECK_FAILED", "AUTH_CHECK_TIMEOUT", "CREDENTIAL_ACCESS_FAILED"])("authentication failure %s terminates with its original error", async (errorCode) => {
  vi.useFakeTimers();
  const tasks = queue();
  const task = tasks.create({ source: "123" });
  const config = loadConfig({ APPTRACE_WORKSPACE_ROOT: path.dirname(tasks.filename) }, "win32");
  vi.spyOn(OnboardingService.prototype, "status").mockImplementation(async (requireAccount = true) => ({
    state: requireAccount ? "failed" : "ready", errorCode: requireAccount ? errorCode : undefined,
    message: "controlled authentication failure", updatedAt: new Date().toISOString()
  }));
  vi.spyOn(AppAnalysisService.prototype, "prepareTarget").mockResolvedValue({ targetId: "target", requiresAccount: true });
  const analyze = vi.spyOn(AppAnalysisService.prototype, "analyzeApp");
  const worker = runAnalysisWorker(config, task.id, "unused-cli");
  await vi.advanceTimersByTimeAsync(2000);
  const result = tasks.get(task.id);
  tasks.cancel(task.id);
  await vi.advanceTimersByTimeAsync(2000);
  await worker;
  expect(result).toMatchObject({ status: "failed", error: { code: errorCode, message: "controlled authentication failure" } });
  expect(analyze).not.toHaveBeenCalled();
});

test("a worker exiting before claiming its task reports a persistent startup failure", async () => {
  const tasks = queue();
  const task = tasks.create({ source: "123" });
  const root = path.dirname(tasks.filename);
  const entry = path.join(root, "exit.cjs");
  fs.writeFileSync(entry, "process.exit(7)");
  await startAnalysisWorker(loadConfig({ APPTRACE_WORKSPACE_ROOT: root }), task.id, entry);
  expect(tasks.get(task.id)).toMatchObject({ status: "failed", error: { code: "WORKER_START_FAILED" } });
  expect(tasks.get(task.id)?.owner).toBeUndefined();
});

test("a missing worker entry fails the saved task instead of leaving it queued", async () => {
  const tasks = queue();
  const task = tasks.create({ source: "123" });
  const root = path.dirname(tasks.filename);
  await startAnalysisWorker(loadConfig({ APPTRACE_WORKSPACE_ROOT: root }), task.id, path.join(root, "missing.cjs"));
  expect(tasks.get(task.id)).toMatchObject({ status: "failed", error: { code: "WORKER_ENTRY_MISSING" } });
});

test("startup waits for a task acknowledgement and preserves the worker result", async () => {
  const tasks = queue();
  const task = tasks.create({ source: "123" });
  const root = path.dirname(tasks.filename);
  const entry = path.join(root, "ack.cjs");
  fs.writeFileSync(entry, `
    const {DatabaseSync} = require('node:sqlite');
    const database = new DatabaseSync(${JSON.stringify(tasks.filename)});
    const task = JSON.parse(database.prepare('SELECT payload FROM tasks WHERE id=?').get(process.argv[3]).payload);
    task.status = 'completed'; task.stage = 'completed'; task.result = { acknowledged: true };
    database.prepare('UPDATE tasks SET payload=? WHERE id=?').run(JSON.stringify(task), task.id);
    database.close();
  `);
  await startAnalysisWorker(loadConfig({ APPTRACE_WORKSPACE_ROOT: root }), task.id, entry);
  expect(tasks.get(task.id)).toMatchObject({ status: "completed", result: { acknowledged: true } });
});
