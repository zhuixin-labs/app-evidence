import { expect, test, vi } from "vitest";
import type { McpServer } from "@modelcontextprotocol/server";
import type { OnboardingService } from "@zhuixin/metadata";
import { registerOnboarding } from "../src/onboarding.js";

test("account status without a wait budget gets a full check timeout", async () => {
  const handlers = new Map<string, (args: object) => Promise<unknown>>();
  const status = vi.fn(async (_account: boolean, timeout: number) => {
    await new Promise(resolve => setTimeout(resolve, 10));
    return { state: timeout >= 10 ? "ready" : "failed", updatedAt: "now", message: "checked" };
  });
  registerOnboarding({ registerTool: (name: string, _spec: unknown, handler: (args: object) => Promise<unknown>) => handlers.set(name, handler) } as unknown as McpServer,
    { status } as unknown as OnboardingService);
  const clock = vi.spyOn(Date, "now");
  clock.mockReturnValueOnce(1000).mockReturnValue(1002);
  try {
    const result = await handlers.get("get_setup_status")!({ require_account: true });
    expect(status).toHaveBeenCalledWith(true, 5000);
    expect(result).toMatchObject({ structuredContent: { state: "ready" } });
  } finally { clock.mockRestore(); }
});
