import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { version } from "../package.json";
import { resolveTool } from "./tools.js";
import {
  CHANNELS,
  accountCheckSchema,
  accountStatusSchema,
  capabilitiesListSchema,
  createJobSchema,
  createTargetSchema,
  evidenceListSchema,
  findingsSearchSchema,
  jobIdSchema,
  resolveInputSchema,
  targetIdSchema,
  terminalInputSchema,
  terminalStartSchema,
  terminalStopSchema,
  type CoreEvent,
  type ResolveResult,
  type SourceDescriptor
} from "@zhuixin/shared";
import { CapabilityRegistry } from "./capabilities/registry.js";
import type { CoreConfig } from "./config.js";
import { AccountService } from "./account/service.js";
import { fail } from "./errors.js";
import { AcquireJobRunner } from "./jobs/acquire.js";
import { EngineCapabilityRunner } from "./jobs/engine.js";
import { AppStoreProvider } from "./sources/appStore.js";
import { SourceRegistry } from "./sources/registry.js";
import { createStore, type Store } from "./store.js";
import { TerminalManager } from "./terminal/manager.js";
import { targetSlug, WorkspaceService } from "./workspace.js";

interface CachedResolution {
  target: ResolveResult["target"];
  provider: SourceDescriptor;
  raw: unknown;
}

export interface CoreServerOptions {
  config: CoreConfig;
  emit: (event: CoreEvent) => void;
  fetchImpl?: typeof fetch;
}

export class CoreServer {
  get config(): CoreConfig {
    return this.options.config;
  }

  readonly store: Store;
  readonly workspace: WorkspaceService;
  readonly registry: SourceRegistry;
  readonly capabilityRegistry: CapabilityRegistry;
  private readonly runner: AcquireJobRunner;
  private readonly capabilityRunner: EngineCapabilityRunner;
  private readonly terminals: TerminalManager;
  private readonly account: AccountService;
  private readonly resolutions = new Map<string, CachedResolution>();

  constructor(private readonly options: CoreServerOptions) {
    this.workspace = new WorkspaceService(options.config.workspaceRoot);
    this.store = createStore(path.join(options.config.workspaceRoot, "workbench.sqlite"));
    this.registry = new SourceRegistry([new AppStoreProvider(options.fetchImpl)]);
    this.capabilityRegistry = new CapabilityRegistry(options.config);
    this.runner = new AcquireJobRunner(
      this.store,
      this.workspace,
      options.config,
      options.emit
    );
    this.capabilityRunner = new EngineCapabilityRunner(
      this.store,
      this.workspace,
      options.config,
      this.capabilityRegistry,
      options.emit
    );
    this.terminals = new TerminalManager(options.config.ipatoolPath, options.emit);
    this.account = new AccountService(options.config);
  }

  async handle(channel: string, payload: unknown): Promise<unknown> {
    switch (channel) {
      case CHANNELS.health:
        return {
          version,
          workspaceRoot: this.options.config.workspaceRoot,
          hostPlatform: this.options.config.hostPlatform,
          store: this.store.kind,
          tools: [
            {
              id: "rea",
              label: "Analysis engine",
              path: this.options.config.enginePath,
              available: fs.existsSync(this.options.config.enginePath)
            },
            {
              id: "ipatool",
              label: "ipatool",
              path: this.options.config.ipatoolPath,
              available: Boolean(resolveTool(this.options.config.ipatoolPath))
            },
            {
              id: "analysis-cli",
              label: "REA command",
              path: this.options.config.analysisEnginePath,
              available: Boolean(resolveTool(this.options.config.analysisEnginePath))
            },
            ...(process.env.JAVA_HOME
              ? [
                  {
                    id: "java",
                    label: "JDK",
                    path: process.env.JAVA_HOME,
                    available: fs.existsSync(process.env.JAVA_HOME)
                  }
                ]
              : []),
            ...(process.env.GHIDRA_INSTALL_DIR
              ? [
                  {
                    id: "ghidra",
                    label: "Ghidra",
                    path: process.env.GHIDRA_INSTALL_DIR,
                    available: fs.existsSync(process.env.GHIDRA_INSTALL_DIR)
                  }
                ]
              : [])
          ]
        };

      case CHANNELS.sourcesList:
        return this.registry.list();

      case CHANNELS.targetsResolve: {
        const { input } = resolveInputSchema.parse(payload);
        const { output, descriptor } = await this.registry.resolve(input);
        const resolutionId = randomUUID();
        this.resolutions.set(resolutionId, {
          target: output.target,
          provider: descriptor,
          raw: output.raw
        });
        return {
          resolutionId,
          target: output.target,
          provider: descriptor
        } satisfies ResolveResult;
      }

      case CHANNELS.targetsCreate: {
        const { resolutionId } = createTargetSchema.parse(payload);
        const cached = this.resolutions.get(resolutionId);
        if (!cached) {
          fail("RESOLUTION_EXPIRED", "Resolution expired; resolve the link again.");
        }

        const existing = this.store.findTarget(
          cached.target.targetRef.platform,
          cached.target.targetRef.sourceId,
          cached.target.targetRef.sourceRef
        );
        const createdAt = new Date().toISOString();
        const target = existing
          ? {
              ...existing,
              ...cached.target,
              id: existing.id,
              slug: existing.slug,
              createdAt: existing.createdAt,
              updatedAt: createdAt
            }
          : {
              ...cached.target,
              id: randomUUID(),
              slug: targetSlug(cached.target.name, cached.target.targetRef.sourceRef),
              createdAt,
              updatedAt: createdAt
            };

        this.store.upsertTarget(target);
        this.workspace.saveResolvedTarget(target, cached.raw);
        this.resolutions.delete(resolutionId);
        this.options.emit({ type: "target.updated", payload: target });
        return target;
      }

      case CHANNELS.targetsList:
        return this.store.listTargets();

      case CHANNELS.targetsGet: {
        const { targetId } = targetIdSchema.parse(payload);
        const target = this.store.getTarget(targetId);
        if (!target) fail("TARGET_NOT_FOUND", "Target not found.");
        return {
          target,
          artifacts: this.store.listArtifacts(target.id),
          jobs: this.store.listJobs(target.id)
        };
      }

      case CHANNELS.jobsCreate: {
        const { targetId, capabilityId, artifactId, input } =
          createJobSchema.parse(payload);
        if (capabilityId === "acquire:app-store") {
          if (input || artifactId) {
            fail("INVALID_INPUT", "acquire:app-store does not accept analysis input.");
          }
          return this.runner.createAcquireJob(targetId);
        }
        return this.capabilityRunner.create(
          targetId,
          capabilityId,
          input,
          artifactId
        );
      }

      case CHANNELS.jobsGet: {
        const { jobId } = jobIdSchema.parse(payload);
        const job = this.store.getJob(jobId);
        if (!job) fail("JOB_NOT_FOUND", "Job not found.");
        return { job, events: this.store.listEvents(job.id) };
      }

      case CHANNELS.jobsCancel: {
        const { jobId } = jobIdSchema.parse(payload);
        const existing = this.store.getJob(jobId);
        if (!existing) fail("JOB_NOT_FOUND", "Job not found.");
        const job =
          existing.capabilityId === "acquire:app-store"
            ? this.runner.cancel(jobId)
            : this.capabilityRunner.cancel(jobId);
        return job;
      }

      case CHANNELS.capabilitiesList: {
        const { targetId } = capabilitiesListSchema.parse(payload) ?? {};
        if (!targetId) return this.capabilityRegistry.list();
        const target = this.store.getTarget(targetId);
        if (!target) fail("TARGET_NOT_FOUND", "Target not found.");
        const artifacts = this.store.listArtifacts(target.id);
        const artifact =
          artifacts.find((item) => item.isCurrent) ?? artifacts[0];
        return this.capabilityRegistry.list({ target, artifact });
      }

      case CHANNELS.findingsSearch: {
        const input = findingsSearchSchema.parse(payload);
        return this.store.searchFindings({
          targetId: input.targetId,
          query: input.query,
          types: input.types,
          limit: input.limit,
          offset: input.offset
        });
      }

      case CHANNELS.evidenceList: {
        const { targetId } = evidenceListSchema.parse(payload);
        return this.store.listEvidence(targetId);
      }

      case CHANNELS.terminalStart: {
        const { kind } = terminalStartSchema.parse(payload);
        return this.terminals.start(kind);
      }

      case CHANNELS.terminalInput: {
        const { sessionId, data } = terminalInputSchema.parse(payload);
        this.terminals.input(sessionId, data);
        return { ok: true };
      }

      case CHANNELS.terminalStop: {
        const { sessionId } = terminalStopSchema.parse(payload);
        this.terminals.stop(sessionId);
        return { ok: true };
      }

      case CHANNELS.accountStatus: {
        const { force } = accountStatusSchema.parse(payload ?? {});
        return this.account.status(force);
      }

      case CHANNELS.accountEntitlements: {
        const { force } = accountStatusSchema.parse(payload ?? {});
        return this.account.entitlements(force);
      }

      case CHANNELS.accountCheckEntitlement: {
        const input = accountCheckSchema.parse(payload);
        return this.account.checkEntitlement(input);
      }

      default:
        fail("UNKNOWN_CHANNEL", `Unknown IPC channel: ${channel}`);
    }
  }

  close(): void {
    this.terminals.closeAll();
    this.store.close();
  }
}
