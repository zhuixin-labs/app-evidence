import { AnalysisTasks, terminalTask, type AnalysisTask } from "@zhuixin/metadata";

export function taskResponse(task: AnalysisTask): Record<string, unknown> {
  return {
    runId: task.id, status: task.status, stage: task.stage, targetId: task.targetId,
    startedAt: task.startedAt, updatedAt: task.updatedAt, finishedAt: task.finishedAt,
    setup: task.setup, result: task.result, error: task.error,
    next_tool: terminalTask(task) ? undefined : "get_analysis_run",
    nextAction: terminalTask(task) ? undefined : task.stage === "login_cancelled"
      ? "登录已取消或失败，任务已保留；等待用户明确重试后调用 open_login。"
      : "任务由本地 Worker 自动继续。保留 runId 并调用 get_analysis_run 等待；不要要求用户确认登录完成或重发 analyze_app。"
  };
}

export async function waitForTask(tasks: AnalysisTasks, id: string, seconds: number): Promise<Record<string, unknown>> {
  const deadline = Date.now() + seconds * 1000;
  let task = tasks.get(id)!;
  const stage = task.stage;
  while (!terminalTask(task) && task.stage !== "login_cancelled" && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, Math.min(500, deadline - Date.now())));
    task = tasks.get(id)!;
    if (task.stage !== stage) break;
  }
  return taskResponse(task);
}
