#!/usr/bin/env node
import {
  AppAnalysisService,
  CoreFailure,
  CoreServer,
  VersionComparisonService,
  loadConfig,
  type AnalysisGoal,
  type CoreConfig
} from "@zhuixin/metadata";
import { CHANNELS } from "@zhuixin/shared";
import { McpServer } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import { z } from "zod";

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
      ? "运行 apptrace auth login，然后重试。"
      : failure.code === "LICENSE_REQUIRED"
        ? "请先在同一 Apple 账号的 App Store 获取该应用。"
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
  core.store.interruptRunningAnalysisRuns();
  const analysis = new AppAnalysisService(core);
  const runs = new Map<
    string,
    {
      id: string;
      status: "running" | "completed" | "failed";
      startedAt: string;
      finishedAt?: string;
      result?: Record<string, unknown>;
      error?: { code: string; message: string; details?: unknown };
      promise: Promise<void>;
    }
  >();
  const mcp = new McpServer({
    name: "apptrace",
    version: "0.1.0"
  });

  mcp.registerTool(
    "analyze_app",
    {
      title: "Analyze an application",
      description:
        "Resolve, acquire, inspect, extract and statically analyze an authorized app. Returns a compact evidence summary.",
      inputSchema: z.object({
        source: z
          .string()
          .optional()
          .describe("App Store URL or numeric App Store ID"),
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
          new CoreFailure("SOURCE_REQUIRED", "请提供 source 或 target_id。")
        );
      }
      try {
        const runId = randomUUID();
        const run: {
          id: string;
          status: "running" | "completed" | "failed";
          startedAt: string;
          finishedAt?: string;
          result?: Record<string, unknown>;
          error?: { code: string; message: string; details?: unknown };
          promise: Promise<void>;
        } = {
          id: runId,
          status: "running",
          startedAt: new Date().toISOString(),
          promise: Promise.resolve()
        };
        run.promise = analysis
          .analyzeApp({
            source: input.source,
            targetId: input.target_id,
            goals: input.goals,
            force: input.force,
            timeoutMs: (input.timeout_seconds ?? 1_200) * 1_000
          })
          .then((result) => {
            run.status = "completed";
            run.result = result as unknown as Record<string, unknown>;
            run.finishedAt = new Date().toISOString();
            core.store.upsertAnalysisRun({
              id: run.id,
              targetId: input.target_id,
              status: "completed",
              startedAt: run.startedAt,
              finishedAt: run.finishedAt,
              result: run.result,
              updatedAt: run.finishedAt
            });
          })
          .catch((error: unknown) => {
            const failure =
              error instanceof CoreFailure
                ? error
                : new CoreFailure(
                    "INTERNAL_ERROR",
                    error instanceof Error ? error.message : String(error)
                  );
            run.status = "failed";
            run.error = {
              code: failure.code,
              message: failure.message,
              details: failure.details
            };
            run.finishedAt = new Date().toISOString();
            core.store.upsertAnalysisRun({
              id: run.id,
              targetId: input.target_id,
              status: "failed",
              startedAt: run.startedAt,
              finishedAt: run.finishedAt,
              error: run.error,
              updatedAt: run.finishedAt
            });
          });
        runs.set(runId, run);
        core.store.upsertAnalysisRun({
          id: runId,
          targetId: input.target_id,
          status: "running",
          startedAt: run.startedAt,
          updatedAt: run.startedAt
        });
        const waitSeconds = Math.max(0, input.wait_seconds ?? 10);
        await Promise.race([
          run.promise,
          new Promise((resolve) => setTimeout(resolve, waitSeconds * 1_000))
        ]);
        return textResult({
          runId,
          status: run.status,
          result: run.result,
          error: run.error,
          nextAction:
            run.status === "running"
              ? "调用 get_analysis_run 继续等待或读取结果。"
              : undefined
        });
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
        "Wait for or retrieve the result of an analyze_app run.",
      inputSchema: z.object({
        run_id: z.string().uuid(),
        wait_seconds: z.number().int().min(0).max(1800).optional()
      })
    },
    async ({ run_id, wait_seconds }) => {
      const run = runs.get(run_id);
      if (!run) {
        const stored = core.store.getAnalysisRun(run_id);
        return stored
          ? textResult(stored)
          : errorResult(
              new CoreFailure("ANALYSIS_RUN_NOT_FOUND", "分析运行不存在或已经超时。")
            );
      }
      await Promise.race([
        run.promise,
        new Promise((resolve) =>
          setTimeout(resolve, Math.max(0, wait_seconds ?? 10) * 1_000)
        )
      ]);
      return textResult({
        runId: run.id,
        status: run.status,
        startedAt: run.startedAt,
        finishedAt: run.finishedAt,
        result: run.result,
        error: run.error
      });
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
        "List analysis capabilities available for the host and an optional target.",
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

const invokedDirectly =
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href;
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
