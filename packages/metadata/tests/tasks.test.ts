import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { AnalysisTasks } from "../src/app/tasks.js";
import { runAnalysisWorker } from "../src/app/worker.js";
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

test("worker waits through login cancellation then resumes the original request once authenticated", async () => {
  vi.useFakeTimers();
  const tasks = queue();
  const task = tasks.create({ source: "123", goals: ["report"], force: true });
  const config = loadConfig({ APPTRACE_WORKSPACE_ROOT: path.dirname(tasks.filename) }, "linux");
  let authenticated = false;
  const open = vi.spyOn(OnboardingService.prototype, "openLogin");
  vi.spyOn(OnboardingService.prototype, "status").mockImplementation(async (requireAccount = true) => ({
    state: !requireAccount || authenticated ? "ready" : "login_required",
    errorCode: !requireAccount || authenticated ? undefined : "LOGIN_CANCELLED_OR_FAILED",
    message: "controlled status", updatedAt: new Date().toISOString()
  }));
  vi.spyOn(AppAnalysisService.prototype, "prepareTarget").mockResolvedValue({ targetId: "target", requiresAccount: true });
  const analyze = vi.spyOn(AppAnalysisService.prototype, "analyzeApp").mockResolvedValue({ targetId: "target" } as never);
  const worker = runAnalysisWorker(config, task.id, "unused-cli");
  await vi.advanceTimersByTimeAsync(4000);
  expect(tasks.get(task.id)).toMatchObject({ status: "awaiting_auth", stage: "login_cancelled" });
  expect(analyze).not.toHaveBeenCalled();
  expect(open).not.toHaveBeenCalled();
  authenticated = true;
  await vi.advanceTimersByTimeAsync(2000);
  await worker;
  expect(tasks.get(task.id)?.status).toBe("completed");
  expect(analyze).toHaveBeenCalledTimes(1);
  expect(analyze).toHaveBeenCalledWith(expect.objectContaining({ source: "123", goals: ["report"], force: true }));
});
