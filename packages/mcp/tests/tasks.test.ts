import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import { AnalysisTasks } from "@zhuixin/metadata";
import { taskResponse, waitForTask } from "../src/tasks.js";

test("task response retains runId and waiting guidance without exposing worker ownership", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "apptrace mcp task "));
  try {
    const tasks = new AnalysisTasks(root);
    const task = tasks.create({ source: "123" });
    const token = tasks.claim(task.id)!;
    tasks.update(task.id, token, { status: "awaiting_auth", stage: "authentication" });
    const response = await waitForTask(tasks, task.id, 0);
    expect(response).toMatchObject({ runId: task.id, status: "awaiting_auth", next_tool: "get_analysis_run" });
    expect(response).not.toHaveProperty("owner");
    expect(response).not.toHaveProperty("arguments");
    tasks.update(task.id, token, { stage: "login_cancelled" });
    expect(taskResponse(tasks.get(task.id)!).nextAction).toContain("explicit retry");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
