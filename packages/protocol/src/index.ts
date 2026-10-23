import { z } from "zod";

export const PROTOCOL_VERSION = "1";
export const engineCapabilities = [
  "inspect:ipa",
  "inspect:mac-app",
  "inspect:pe",
  "extract:app",
  "javascript:analyze",
  "native:inspect",
  "native:search",
  "native:decompile",
  "compare:versions",
  "generate:report"
] as const;

export type EngineCapability = (typeof engineCapabilities)[number];

export const engineRequestSchema = z.object({
  id: z.string(),
  protocolVersion: z.literal(PROTOCOL_VERSION),
  operation: z.enum(["health", "execute"]),
  capability: z.enum(engineCapabilities).optional(),
  targetId: z.string().uuid().optional(),
  artifactId: z.string().uuid().optional(),
  workspacePath: z.string().min(1),
  input: z.record(z.unknown()).optional(),
  license: z.object({
    licenseId: z.string().optional(),
    features: z.array(z.string()).default([]),
    token: z.string().optional()
  }).optional()
});

export const engineResponseSchema = z.object({
  id: z.string(),
  ok: z.boolean(),
  result: z.record(z.unknown()).optional(),
  error: z.object({
    code: z.string(),
    message: z.string(),
    details: z.unknown().optional()
  }).optional()
});

export type EngineRequest = z.infer<typeof engineRequestSchema>;
export type EngineResponse = z.infer<typeof engineResponseSchema>;
