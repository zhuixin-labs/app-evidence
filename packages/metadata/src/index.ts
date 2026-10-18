export { CoreServer, CoreServer as MetadataServer } from "./server.js";
export type { CoreServerOptions as MetadataServerOptions } from "./server.js";
export { loadConfig } from "./config.js";
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
