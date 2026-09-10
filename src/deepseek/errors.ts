// DeepSeek Web Protocol Errors
// Protocol-specific error types — no application-layer translations

export type DeepSeekErrorKind =
  | "authentication"
  | "session"
  | "pow"
  | "completion"
  | "sse"
  | "protocol"
  | "unknown";

export class DeepSeekProtocolError extends Error {
  readonly kind: DeepSeekErrorKind;
  readonly status?: number;
  readonly code?: string | number | null;
  readonly raw?: unknown;

  constructor(
    message: string,
    options: {
      kind: DeepSeekErrorKind;
      status?: number;
      code?: string | number | null;
      raw?: unknown;
    },
  ) {
    super(message);
    this.name = "DeepSeekProtocolError";

    this.kind = options.kind;
    this.status = options.status;
    this.code = options.code;
    this.raw = options.raw;
  }
}

export function toDeepSeekError(error: unknown, fallbackKind: DeepSeekErrorKind = "unknown"): DeepSeekProtocolError {
  if (error instanceof DeepSeekProtocolError) return error;
  if (error instanceof Error) {
    return new DeepSeekProtocolError(error.message, { kind: fallbackKind, raw: error });
  }
  return new DeepSeekProtocolError(String(error), { kind: fallbackKind, raw: error });
}