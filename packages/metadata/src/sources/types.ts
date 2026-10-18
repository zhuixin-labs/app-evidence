import type {
  ResolvedTarget,
  SourceDescriptor,
  SourceId
} from "@zhuixin/shared";

export interface ResolveOutput {
  target: ResolvedTarget;
  raw: unknown;
}

export interface SourceProvider {
  readonly descriptor: SourceDescriptor;
  canHandle(input: string): boolean;
  resolve(input: string): Promise<ResolveOutput>;
}

export function descriptor(
  id: SourceId,
  platform: SourceDescriptor["platform"],
  displayName: string,
  requiresAuth: boolean,
  status: SourceDescriptor["status"],
  description: string
): SourceDescriptor {
  return { id, platform, displayName, requiresAuth, status, description };
}
