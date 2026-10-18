export class CoreFailure extends Error {
  readonly code: string;
  readonly details?: unknown;

  constructor(code: string, message: string, details?: unknown) {
    super(message);
    this.name = "CoreFailure";
    this.code = code;
    this.details = details;
  }
}

export function fail(code: string, message: string, details?: unknown): never {
  throw new CoreFailure(code, message, details);
}
