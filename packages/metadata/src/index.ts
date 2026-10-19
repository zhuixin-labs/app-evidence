export { CoreServer, CoreServer as MetadataServer } from "./server.js";
export type { CoreServerOptions as MetadataServerOptions } from "./server.js";
export { loadConfig } from "./config.js";
export { resolveTool } from "./tools.js";
export { OnboardingService, runInstallation, missingSetupTools, trackInstallationChild } from "./onboarding/service.js";
export type { SetupStatus } from "./onboarding/service.js";
export type { CoreConfig } from "./config.js";
export { createStore } from "./store.js";
export { WorkspaceService } from "./workspace.js";
export { SourceRegistry } from "./sources/registry.js";
export { AppAnalysisService } from "./app/analysis.js";
export { VersionComparisonService } from "./app/compare.js";
export type {
  AnalysisGoal,
  AnalyzeAppOptions,
  AnalyzeAppResult,
  AnalysisProgress
} from "./app/analysis.js";
export type {
  CompareVersionsResult,
  VersionDiff,
  VersionSnapshot
} from "./app/compare.js";
export { CoreFailure } from "./errors.js";
export { installEngineArtifact } from "./engine/install.js";
