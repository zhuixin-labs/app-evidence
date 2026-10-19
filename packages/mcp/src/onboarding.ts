import { OnboardingService, type SetupStatus } from "@zhuixin/metadata";
import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

function result(status: SetupStatus) {
  return { content: [{ type: "text" as const, text: JSON.stringify(status) }], structuredContent: { ...status } };
}

export function registerOnboarding(mcp: McpServer, service: OnboardingService): void {
  mcp.registerTool("prepare_environment", {
    title: "Prepare AppTrace automatically",
    description: "Install missing local analysis tools using the bundled installer. Returns promptly; poll get_setup_status. No Apple credentials are accepted. Retry only after diagnosing a previous failure.",
    inputSchema: z.object({ retry: z.boolean().optional() })
  }, async ({ retry }) => result(await service.prepare(retry)));
  mcp.registerTool("get_setup_status", {
    title: "Wait for environment and login readiness",
    description: "Read persistent installation progress and safe Apple login status. Follow next_tool; when ready, resume the original analyze_app arguments without asking the user to repeat them.",
    inputSchema: z.object({ wait_seconds: z.number().int().min(0).max(30).optional(), require_account: z.boolean().default(false).describe("Set true when waiting for Apple sign-in; local artifact analysis needs no account.") })
  }, async ({ wait_seconds, require_account }) => {
    const deadline = Date.now() + (wait_seconds ?? 0) * 1000;
    const check = () => service.status(require_account, (wait_seconds ?? 0) > 0
      ? Math.max(1, Math.min(5000, deadline - Date.now())) : 5000);
    let status = await check();
    while (["installing", "login_pending"].includes(status.state) && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, Math.min(2000, deadline - Date.now())));
      if (Date.now() >= deadline) break;
      status = await check();
    }
    return result(status);
  });
  mcp.registerTool("open_login", {
    title: "Open local Apple sign-in window",
    description: "Open a visible Windows sign-in terminal for the user. Reuses an active sign-in window. Credentials and terminal output never enter MCP. Poll get_setup_status afterwards, then resume the original analysis. Other hosts return a local-terminal fallback.",
    inputSchema: z.object({})
  }, async () => result(await service.openLogin()));
}

export function setupResponse(status: SetupStatus, input: Record<string, unknown>) {
  return {
    status: "awaiting_setup",
    setup: status,
    next_tool: status.next_tool,
    resume: { tool: "analyze_app", arguments: input },
    nextAction: "Follow next_tool to finish setup; once ready, resend analyze_app with resume.arguments. Do not ask the user to repeat the request or for credentials."
  };
}
