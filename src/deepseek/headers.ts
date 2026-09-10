// DeepSeek Web Protocol Headers
// Centralized DeepSeek-specific header construction

import { DEEPSEEK, DEFAULT_TIMEZONE_OFFSET } from "./constants.js";
import type { DeepSeekCredentials, DeepSeekClientHeaders } from "./types.js";

export function buildClientHeaders(): Omit<DeepSeekClientHeaders, "authorization" | "cookie" | "x-hif-leim" | "x-ds-pow-response" | "accept"> {
  return {
    "x-client-bundle-id": DEEPSEEK.CLIENT.BUNDLE_ID,
    "x-client-platform": DEEPSEEK.CLIENT.PLATFORM,
    "x-client-version": DEEPSEEK.CLIENT.VERSION,
    "x-client-locale": DEEPSEEK.CLIENT.LOCALE,
    "x-client-timezone-offset": DEFAULT_TIMEZONE_OFFSET,
    "content-type": "application/json",
  };
}

export function getDeepSeekTimezoneOffset(): string {
  // Wire representation as observed in browser traffic
  // Not simply new Date().getTimezoneOffset() — uses the protocol's observed convention
  return DEFAULT_TIMEZONE_OFFSET;
}

export function buildAuthenticationHeaders(credentials: DeepSeekCredentials): Record<string, string> {
  const headers: Record<string, string> = {
    ...buildClientHeaders(),
    accept: "*/*",
  };

  if (credentials.authorization) {
    headers["authorization"] = credentials.authorization;
  }

  if (credentials.cookie) {
    headers["cookie"] = credentials.cookie;
  }

  return headers;
}

export function buildCompletionHeaders(
  credentials: DeepSeekCredentials,
  powResponse: string,
  hifLeim?: string,
): Headers {
  const headers = new Headers(buildAuthenticationHeaders(credentials));
  headers.set("accept", "text/event-stream");
  headers.set("x-ds-pow-response", powResponse);

  if (hifLeim) {
    headers.set("x-hif-leim", hifLeim);
  }

  return headers;
}

export interface HeaderBuildOptions {
  credentials: DeepSeekCredentials;
  powResponse?: string;
  hifLeim?: string;
  accept?: string;
}

export function buildHeaders(options: HeaderBuildOptions): Headers {
  const headers = new Headers(buildAuthenticationHeaders(options.credentials));

  if (options.accept) {
    headers.set("accept", options.accept);
  }

  if (options.powResponse) {
    headers.set("x-ds-pow-response", options.powResponse);
  }

  if (options.hifLeim) {
    headers.set("x-hif-leim", options.hifLeim);
  }

  return headers;
}