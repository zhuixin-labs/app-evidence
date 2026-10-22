#!/usr/bin/env node
import { version } from "../package.json";
import {
  AppAnalysisService,
  CoreFailure,
  CoreServer,
  VersionComparisonService,
  loadConfig,
  OnboardingService,
  AnalysisTasks,
  startAnalysisWorker,
  recoverAnalysisTasks,
  type AnalysisGoal,
  type CoreConfig
} from "@zhuixin/metadata";
import { CHANNELS } from "@zhuixin/shared";
import { McpServer } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { registerOnboarding } from "./onboarding.js";
import { waitForTask } from "./tasks.js";

const GOALS = [
  "tech_stack",
  "feature_map",
  "network",
  "native_risk",
  "report"
] as const satisfies readonly AnalysisGoal[];

function errorResult(error: unknown) {
  const failure =
    error instanceof CoreFailure
      ? error
      : new CoreFailure(
          "INTERNAL_ERROR",
          error instanceof Error ? error.message : String(error)
        );
  const nextAction =
    failure.code === "AUTH_REQUIRED" || failure.code === "KEYCHAIN_LOCKED"
      ? "Call open_login, poll get_setup_status, then resume the original request."
      : failure.code === "LICENSE_REQUIRED"
        ? "Get the app from the App Store with the same Apple account first."
        : undefined;
  return {
    isError: true,
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(
          {
            code: failure.code,
            message: failure.message,
            details: failure.details,
            nextAction
          },
          null,
          2
        )
      }
    ]
  };
}

function textResult(value: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(value, null, 2)
      }
    ],
    structuredContent: value as Record<string, unknown>
  };
}

function jobResult(job: Record<string, unknown>) {
  return {
    jobId: job.id,
    capabilityId: job.capabilityId,
    status: job.status,
    result: job.result,
    errorCode: job.errorCode,
    errorMessage: job.errorMessage
  };
}

export async function startMcpServer(
  config: CoreConfig = loadConfig()
): Promise<McpServer> {
  const core = new CoreServer({ config, emit: () => {} });
  const analysis = new AppAnalysisService(core);
  const tasks = new AnalysisTasks(config.workspaceRoot);
  await recoverAnalysisTasks(config);
  const mcp = new McpServer({
    name: "apptrace",
    version
  });
  const onboarding = new OnboardingService(config);
  registerOnboarding(mcp, onboarding);

  mcp.registerTool(
    "analyze_app",
    {
      title: "Analyze an application",
      description:
        "Create a persistent application analysis task. A local worker prepares tools, opens sign-in once and automatically continues after background authentication succeeds, even if MCP disconnects. Always retain runId and poll get_analysis_run while preparing/awaiting_auth/running. Never request credentials in chat.",
      inputSchema: z.object({
        source: z
          .string()
          .optional()
          .describe(
            "App Store URL or numeric App Store ID, or a local macOS app: a path to a .app folder, or to a .zip that contains one"
          ),
        target_id: z
          .string()
          .uuid()
          .optional()
          .describe("Existing AppTrace target ID"),
        goals: z
          .array(z.enum(GOALS))
          .optional()
          .describe("Analysis goals; defaults to tech stack, feature map and report"),
        force: z
          .boolean()
          .optional()
          .describe("Re-run analyses even when matching evidence already exists"),
        wait_seconds: z
          .number()
          .int()
          .min(0)
          .max(60)
          .optional()
          .describe("Seconds to wait before returning a running run_id"),
        timeout_seconds: z.number().int().min(30).max(1800).optional()
      })
    },
    async (input) => {
      if (!input.source && !input.target_id) {
        return errorResult(
          new CoreFailure("SOURCE_REQUIRED", "Provide source or target_id.")
        );
      }
      try {
        const task = tasks.create(input);
        await startAnalysisWorker(config, task.id);
        return textResult(await waitForTask(tasks, task.id, input.wait_seconds ?? 10));
      } catch (error) {
        return errorResult(error);
      }
    }
  );

  mcp.registerTool(
    "get_analysis_run",
    {
      title: "Get asynchronous analysis run",
      description:
        "Wait for or retrieve the result of an analyze_app run. The result includes hostPlatform and limitations: tell the user about every limitation (skipped analyses, host-dependent gaps) instead of presenting coverage as complete.",
      inputSchema: z.object({
        run_id: z.string().uuid(),
        wait_seconds: z.number().int().min(0).max(30).optional()
      })
    },
    async ({ run_id, wait_seconds }) => {
      const task = tasks.get(run_id);
      if (task) {
        await startAnalysisWorker(config, task.id);
        return textResult(await waitForTask(tasks, task.id, wait_seconds ?? 10));
      }
      const stored = core.store.getAnalysisRun(run_id);
      return stored ? textResult(stored) : errorResult(new CoreFailure("ANALYSIS_RUN_NOT_FOUND", "Analysis run not found."));
    }
  );

  mcp.registerTool(
    "cancel_analysis_run",
    { title: "Cancel saved analysis task", description: "Cancel a queued, waiting or running analysis task. Already registered artifacts and evidence are retained.", inputSchema: z.object({ run_id: z.string().uuid() }) },
    async ({ run_id }) => {
      const task = tasks.cancel(run_id);
      return task ? textResult(await waitForTask(tasks, task.id, 0)) : errorResult(new CoreFailure("ANALYSIS_RUN_NOT_FOUND", "Analysis run not found."));
    }
  );

  mcp.registerTool(
    "list_targets",
    {
      title: "List application targets",
      description: "List all locally registered AppTrace targets.",
      inputSchema: z.object({})
    },
    async () => {
      try {
        const targets = await core.handle(CHANNELS.targetsList, {});
        return textResult(targets);
      } catch (error) {
        return errorResult(error);
      }
    }
  );

  mcp.registerTool(
    "auth_status",
    {
      title: "Apple account status",
      description:
        "Read the local App Store login state. Never returns passwords, 2FA codes or keychain secrets.",
      inputSchema: z.object({})
    },
    async () => {
      try {
        const status = await core.handle(CHANNELS.accountStatus, {
          force: true
        });
        return textResult(status);
      } catch (error) {
        return errorResult(error);
      }
    }
  );

  mcp.registerTool(
    "get_job",
    {
      title: "Get job status",
      description: "Return a job, its recent events and result.",
      inputSchema: z.object({
        job_id: z.string().uuid()
      })
    },
    async ({ job_id }) => {
      try {
        const result = (await core.handle(CHANNELS.jobsGet, {
          jobId: job_id
        })) as {
          job: Record<string, unknown>;
          events: Array<Record<string, unknown>>;
        };
        return textResult({
          ...result,
          events: result.events.slice(-50)
        });
      } catch (error) {
        return errorResult(error);
      }
    }
  );

  mcp.registerTool(
    "search_findings",
    {
      title: "Search structured findings",
      description:
        "Search persisted routes, modules, assets, endpoints, storage and native findings for a target.",
      inputSchema: z.object({
        target_id: z.string().uuid(),
        query: z.string().trim().max(512).optional(),
        types: z
          .array(
            z.enum([
              "technology",
              "route",
              "network_endpoint",
              "module",
              "asset",
              "storage",
              "native_procedure",
              "native_string",
              "risk",
              "limitation"
            ])
          )
          .optional(),
        limit: z.number().int().min(1).max(1000).optional(),
        offset: z.number().int().min(0).optional()
      })
    },
    async (input) => {
      try {
        return textResult(
          await core.handle(CHANNELS.findingsSearch, {
            targetId: input.target_id,
            query: input.query,
            types: input.types,
            limit: input.limit,
            offset: input.offset
          })
        );
      } catch (error) {
        return errorResult(error);
      }
    }
  );

  mcp.registerTool(
    "search_native",
    {
      title: "Search native symbols",
      description:
        "Search native procedure names or strings. Use a returned procedure name with decompile_function.",
      inputSchema: z.object({
        target_id: z.string().uuid(),
        query: z.string().trim().min(1).max(512),
        kind: z.enum(["procedures", "strings"]).optional(),
        mode: z.enum(["literal", "regex"]).optional()
      })
    },
    async ({ target_id, query, kind, mode }) => {
      try {
        return textResult(
          jobResult(
            (await analysis.runCapability(target_id, "native:search", {
              query,
              kind: kind ?? "procedures",
              mode: mode ?? "literal"
            })) as unknown as Record<string, unknown>
          )
        );
      } catch (error) {
        return errorResult(error);
      }
    }
  );

  mcp.registerTool(
    "decompile_function",
    {
      title: "Decompile one native function",
      description:
        "Decompile an exact function or symbol name returned by search_native. Encrypted targets are refused.",
      inputSchema: z.object({
        target_id: z.string().uuid(),
        function_name: z
          .string()
          .trim()
          .min(1)
          .max(256)
          .regex(/^[A-Za-z_$][A-Za-z0-9_$.@:-]{0,255}$/)
      })
    },
    async ({ target_id, function_name }) => {
      try {
        return textResult(
          jobResult(
            (await analysis.runCapability(target_id, "native:decompile", {
              functionName: function_name
            })) as unknown as Record<string, unknown>
          )
        );
      } catch (error) {
        return errorResult(error);
      }
    }
  );

  mcp.registerTool(
    "list_evidence",
    {
      title: "List evidence",
      description: "List stored evidence files and summaries for a target.",
      inputSchema: z.object({
        target_id: z.string().uuid()
      })
    },
    async ({ target_id }) => {
      try {
        return textResult(
          await core.handle(CHANNELS.evidenceList, {
            targetId: target_id
          })
        );
      } catch (error) {
        return errorResult(error);
      }
    }
  );

  mcp.registerTool(
    "generate_report",
    {
      title: "Generate evidence report",
      description:
        "Generate a Markdown report for an existing target and its current artifact.",
      inputSchema: z.object({
        target_id: z.string().uuid()
      })
    },
    async ({ target_id }) => {
      try {
        return textResult(
          jobResult(
            (await analysis.runCapability(
              target_id,
              "generate:report"
            )) as unknown as Record<string, unknown>
          )
        );
      } catch (error) {
        return errorResult(error);
      }
    }
  );

  mcp.registerTool(
    "compare_versions",
    {
      title: "Compare two artifact versions",
      description:
        "Compare routes, modules, assets, network candidates and technology hints between two analyzed artifacts of the same target.",
      inputSchema: z.object({
        target_id: z.string().uuid(),
        left_artifact_id: z.string().uuid(),
        right_artifact_id: z.string().uuid(),
        force: z.boolean().optional()
      })
    },
    async ({
      target_id,
      left_artifact_id,
      right_artifact_id,
      force
    }) => {
      try {
        return textResult(
          await new VersionComparisonService(core).compare(
            target_id,
            left_artifact_id,
            right_artifact_id,
            { force }
          )
        );
      } catch (error) {
        return errorResult(error);
      }
    }
  );

  mcp.registerTool(
    "list_capabilities",
    {
      title: "List capabilities",
      description:
        "List analysis capabilities available for the host and an optional target. A capability may be available but degraded on this host (for example macOS signature details on a non-macOS host); read each entry's notes and relay them to the user.",
      inputSchema: z.object({
        target_id: z.string().uuid().optional()
      })
    },
    async ({ target_id }) => {
      try {
        return textResult(
          await core.handle(CHANNELS.capabilitiesList, {
            ...(target_id ? { targetId: target_id } : {})
          })
        );
      } catch (error) {
        return errorResult(error);
      }
    }
  );

  const transport = new StdioServerTransport();
  await mcp.connect(transport);

  const close = async () => {
    await mcp.close().catch(() => {});
    core.close();
  };
  process.once("SIGINT", () => void close().finally(() => process.exit(0)));
  process.once("SIGTERM", () => void close().finally(() => process.exit(0)));

  return mcp;
}

const invokedDirectly = isEntryPoint();

function isEntryPoint(): boolean {
  if (!process.argv[1]) return false;
  try {
    // Compare real paths: /tmp and npm bin shims are symlinked on macOS/Linux,
    // and a string comparison silently prevents the server from starting.
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}
if (invokedDirectly) {
  void startMcpServer().catch((error) => {
    console.error(
      `[apptrace-mcp] ${
        error instanceof Error ? error.stack ?? error.message : String(error)
      }`
    );
    process.exitCode = 1;
  });
}
