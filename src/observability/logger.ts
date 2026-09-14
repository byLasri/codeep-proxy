export function generateTraceId(): string {
  return crypto.randomUUID();
}

const SANITIZED_HEADERS = ['authorization', 'cookie', 'x-authorization', 'x-api-key', 'api-key'];

function sanitizeHeaders(headers: Headers): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of headers.entries()) {
    const lowerKey = key.toLowerCase();
    if (SANITIZED_HEADERS.some(h => lowerKey.includes(h))) {
      result[key] = '[REDACTED]';
    } else {
      result[key] = value;
    }
  }
  return result;
}

export class RequestLogger {
  private readonly traceId: string;

  constructor(traceId: string) {
    this.traceId = traceId;
  }

  logIncoming(req: Request, rawBody: string): void {
    const sanitizedHeaders = sanitizeHeaders(req.headers);
    console.log("[OBS] " + JSON.stringify({
      traceId: this.traceId,
      event: "incoming_request",
      method: req.method,
      url: req.url,
      headers: sanitizedHeaders,
      rawBody,
    }));
  }

  logTranslatedRequest(payload: any): void {
    console.log("[OBS] " + JSON.stringify({
      traceId: this.traceId,
      event: "translated_request",
      payload,
    }));
  }

  logUpstreamRequest(url: string, init: RequestInit): void {
    const headers = init.headers ? (init.headers instanceof Headers ? sanitizeHeaders(init.headers) : init.headers) : {};
    const body = init.body ? (typeof init.body === 'string' ? init.body : '[non-string body]') : null;
    console.log("[OBS] " + JSON.stringify({
      traceId: this.traceId,
      event: "upstream_request",
      url,
      method: init.method ?? 'GET',
      headers,
      body,
    }));
  }

  logUpstreamResponse(status: number, headers: Record<string, string>, rawBody: string): void {
    const sanitizedHeaders: Record<string, string> = {};
    for (const [key, value] of Object.entries(headers)) {
      const lowerKey = key.toLowerCase();
      if (SANITIZED_HEADERS.some(h => lowerKey.includes(h))) {
        sanitizedHeaders[key] = '[REDACTED]';
      } else {
        sanitizedHeaders[key] = value;
      }
    }
    console.log("[OBS] " + JSON.stringify({
      traceId: this.traceId,
      event: "upstream_response",
      status,
      headers: sanitizedHeaders,
      rawBody,
    }));
  }

  logOutgoingToClient(payload: any): void {
    console.log("[OBS] " + JSON.stringify({
      traceId: this.traceId,
      event: "outgoing_to_client",
      payload,
    }));
  }

  logError(error: any): void {
    const errorInfo = error instanceof Error ? {
      name: error.name,
      message: error.message,
      stack: error.stack,
    } : {
      value: error,
    };
    console.log("[OBS] " + JSON.stringify({
      traceId: this.traceId,
      event: "error",
      error: errorInfo,
    }));
  }
}

export function teeAndLogStream(
  stream: ReadableStream<Uint8Array>,
  logger: RequestLogger,
  label: string
): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder();
  let buffer = '';
  const chunks: Uint8Array[] = [];

  const teeStream = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      chunks.push(chunk);
      controller.enqueue(chunk);
    },
    async flush() {
      const fullText = decoder.decode(concatUint8Arrays(chunks));
      logger.logUpstreamResponse(200, {}, fullText);
    },
  });

  stream.pipeTo(teeStream.writable).catch(err => {
    logger.logError(err);
  });

  return teeStream.readable;
}

function concatUint8Arrays(arrays: Uint8Array[]): Uint8Array {
  const totalLength = arrays.reduce((sum, arr) => sum + arr.length, 0);
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const arr of arrays) {
    result.set(arr, offset);
    offset += arr.length;
  }
  return result;
}
