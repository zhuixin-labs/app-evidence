import { randomUUID } from "node:crypto";
import path from "node:path";
import type {
  ArtifactRecord,
  FindingRecord,
  TargetDetail,
  TargetRecord
} from "@zhuixin/shared";
import { CoreFailure } from "../errors.js";
import type { CoreServer } from "../server.js";
import { AppAnalysisService } from "./analysis.js";
import { EngineClient } from "@zhuixin/engine-client";

export interface VersionSnapshot {
  artifactId: string;
  version?: string;
  buildNumber?: string;
  sha256: string;
  packageFormat: string;
  architecture?: string;
  cryptid?: number | null;
}

export interface VersionDiff {
  added: string[];
  removed: string[];
  unchanged: string[];
}

export interface CompareVersionsResult {
  targetId: string;
  targetName: string;
  left: VersionSnapshot;
  right: VersionSnapshot;
  technology: VersionDiff;
  routes: VersionDiff;
  modules: VersionDiff;
  assets: VersionDiff;
  networkEndpoints: VersionDiff;
  leftEvidenceIds: string[];
  rightEvidenceIds: string[];
  comparisonPath: string;
  createdAt: string;
  limitations: string[];
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function snapshot(artifact: ArtifactRecord): VersionSnapshot {
  const inspection = record(artifact.inspection);
  const main = record(inspection?.mainExecutable);
  const slices = Array.isArray(main?.slices) ? main.slices : [];
  const cryptid =
    slices
      .map((slice) => record(slice)?.cryptid)
      .find((value) => typeof value === "number") ?? undefined;
  return {
    artifactId: artifact.id,
    version: artifact.version,
    buildNumber: artifact.buildNumber,
    sha256: artifact.sha256,
    packageFormat: artifact.packageFormat,
    architecture: artifact.architecture,
    cryptid
  };
}

export class VersionComparisonService {
  private readonly analysis: AppAnalysisService;

  constructor(private readonly server: CoreServer) {
    this.analysis = new AppAnalysisService(server);
  }

  async compare(
    targetId: string,
    leftArtifactId: string,
    rightArtifactId: string,
    options: { force?: boolean } = {}
  ): Promise<CompareVersionsResult> {
    if (leftArtifactId === rightArtifactId) {
      throw new CoreFailure("INVALID_COMPARISON", "Both versions cannot be the same artifact.");
    }
    let detail = await this.analysis.detail(targetId);
    const left = this.findArtifact(detail, leftArtifactId);
    const right = this.findArtifact(detail, rightArtifactId);
    await this.ensureArtifactAnalysis(detail, left.id, options.force);
    await this.ensureArtifactAnalysis(detail, right.id, options.force);
    detail = await this.analysis.detail(targetId);

    const leftFindings = this.findings(targetId, left.id);
    const rightFindings = this.findings(targetId, right.id);
    const leftSnapshot = snapshot(
      this.findArtifact(detail, left.id)
    );
    const rightSnapshot = snapshot(
      this.findArtifact(detail, right.id)
    );
    const createdAt = new Date().toISOString();
    const comparisonPath = path.join(
      this.server.workspace.targetDir(detail.target),
      "analysis",
      "comparisons",
      `${randomUUID()}.json`
    );
    const engine = new EngineClient(this.server.config.enginePath);
    let diffResult;
    try {
      diffResult = await engine.execute(
        this.server.workspace.root,
        "compare:versions",
        {
          targetId,
          values: {
            leftFindings,
            rightFindings,
            left: leftSnapshot,
            right: rightSnapshot
          },
          licenseToken: this.server.config.licenseToken
        }
      );
    } finally {
      engine.close();
    }
    const result: CompareVersionsResult = {
      targetId,
      targetName: detail.target.name,
      left: leftSnapshot,
      right: rightSnapshot,
      technology: diffResult.technology as VersionDiff,
      routes: diffResult.routes as VersionDiff,
      modules: diffResult.modules as VersionDiff,
      assets: diffResult.assets as VersionDiff,
      networkEndpoints: diffResult.networkEndpoints as VersionDiff,
      leftEvidenceIds: diffResult.leftEvidenceIds as string[],
      rightEvidenceIds: diffResult.rightEvidenceIds as string[],
      comparisonPath: path.relative(
        this.server.workspace.root,
        comparisonPath
      ),
      createdAt,
      limitations: [
        "Version comparison is limited to structured static findings extracted from each artifact.",
        "Added/removed lists are only reliable for coverage recorded in both Evidence sets.",
        "Static findings do not prove runtime behavior or server-side changes."
      ]
    };
    this.server.workspace.writeJson(comparisonPath, result);
    return result;
  }

  private findArtifact(detail: TargetDetail, artifactId: string): ArtifactRecord {
    const artifact = detail.artifacts.find((item) => item.id === artifactId);
    if (!artifact) {
      throw new CoreFailure(
        "ARTIFACT_NOT_FOUND",
        `Artifact not found in target: ${artifactId}`
      );
    }
    return artifact;
  }

  private async ensureArtifactAnalysis(
    detail: TargetDetail,
    artifactId: string,
    force = false
  ): Promise<void> {
    const artifact = this.findArtifact(detail, artifactId);
    if (force || !artifact.inspection || artifact.inspection.error) {
      await this.analysis.runCapability(
        detail.target.id,
        "inspect:ipa",
        undefined,
        artifactId
      );
    }
    const hasJavascriptEvidence = this.server.store
      .listEvidence(detail.target.id)
      .some(
        (evidence) =>
          evidence.artifactId === artifactId &&
          evidence.kind === "javascript-analysis"
      );
    if (force || !hasJavascriptEvidence) {
      await this.analysis.runCapability(
        detail.target.id,
        "javascript:analyze",
        undefined,
        artifactId
      );
    }
  }

  private findings(targetId: string, artifactId: string): FindingRecord[] {
    return this.server.store.searchFindings({
      targetId,
      artifactIds: [artifactId],
      limit: 1000
    }).items;
  }
}
