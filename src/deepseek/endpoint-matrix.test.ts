import assert from "node:assert/strict";
import { createPowChallenge } from "./pow-challenge.js";
import { solvePow, encodePowResponse } from "./pow.js";
import { createSession } from "./session.js";
import { buildCompletionHeaders } from "./headers.js";
import { parseCompletionStream } from "./sse.js";
import { DEEPSEEK } from "./constants.js";
import type { DeepSeekCredentials, DeepSeekModelType } from "./types.js";

/**
 * Live protocol matrix for the DeepSeek web completion endpoint.
 *
 * This file is intentionally standalone: it does not alter production code,
 * package scripts, or runtime behavior. Run it explicitly with tsx.
 *
 * Required environment:
 *   DEEPSEEK_AUTHORIZATION="Bearer ..."    (or omit if cookie-only auth works)
 *   DEEPSEEK_COOKIE="..."                  (optional)
 *
 * Example:
 *   DEEPSEEK_AUTHORIZATION='Bearer ...' DEEPSEEK_COOKIE='...' \
 *     npx tsx src/deepseek/endpoint-matrix.test.ts
 */

const ORIGIN = DEEPSEEK.ORIGIN;
const HIF_ENDPOINT = "https://hif-leim.deepseek.com/query";
const TIMEOUT_MS = Number(process.env.DEEPSEEK_TEST_TIMEOUT_MS ?? 120_000);
const PROMPT = "Reply with exactly: endpoint-matrix-ok";

type Case = {
  model_type: DeepSeekModelType;
  thinking_enabled: boolean;
  search_enabled: boolean;
};

type CaseResult = Case & {
  status: "success" | "rejected" | "failed";
  http_status: number | null;
  ready_model_type: string | null;
  request_message_id: number | null;
  response_message_id: number | null;
  search_enabled_observed: boolean | null;
  search_triggered: boolean | null;
  conversation_mode: string | null;
  error: string | null;
};

const credentials: DeepSeekCredentials = {
  authorization: process.env.DEEPSEEK_AUTHORIZATION,
  cookie: process.env.DEEPSEEK_COOKIE,
};

function requiredCredentialPresent(): boolean {
  return Boolean(credentials.authorization || credentials.cookie);
}

async function withTimeout<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${TIMEOUT_MS}ms`)), TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function fetchHifLeim(): Promise<string> {
  const response = await withTimeout(
    fetch(HIF_ENDPOINT, {
      method: "GET",
      headers: {
        accept: "application/json, text/plain, */*",
        "x-client-bundle-id": DEEPSEEK.CLIENT.BUNDLE_ID,
        "x-client-platform": DEEPSEEK.CLIENT.PLATFORM,
        "x-client-version": DEEPSEEK.CLIENT.VERSION,
        "x-client-locale": DEEPSEEK.CLIENT.LOCALE,
        "x-client-timezone-offset": "3600",
      },
    }),
    "HIF-LEIM query",
  );

  const text = await response.text();
  if (!response.ok) {
    throw new Error(`HIF-LEIM returned HTTP ${response.status}: ${text.slice(0, 500)}`);
  }

  let payload: any;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new Error(`HIF-LEIM returned non-JSON response: ${text.slice(0, 500)}`);
  }

  const value = payload?.data?.biz_data?.value;
  assert.equal(typeof value, "string", "HIF-LEIM response must expose data.biz_data.value");
  assert.ok(value.length > 0, "HIF-LEIM value must be non-empty");
  return value;
}

function buildMatrix(): Case[] {
  const modelTypes: DeepSeekModelType[] = [null, "default", "expert", "vision"];
  const variants: Case[] = [];

  for (const model_type of modelTypes) {
    for (const thinking_enabled of [false, true]) {
      for (const search_enabled of [false, true]) {
        variants.push({ model_type, thinking_enabled, search_enabled });
      }
    }
  }

  return variants;
}

function rawReadyModel(result: Awaited<ReturnType<typeof parseCompletionStream>>): string | null {
  for (const event of result.events) {
    const data = event.data;
    if (
      data &&
      typeof data === "object" &&
      "request_message_id" in data &&
      "response_message_id" in data &&
      "model_type" in data &&
      typeof (data as { model_type?: unknown }).model_type === "string"
    ) {
      return (data as { model_type: string }).model_type;
    }
  }
  return null;
}

async function runCase(hifLeim: string, testCase: Case): Promise<CaseResult> {
  try {
    // A fresh session per matrix cell prevents a prior model/flag combination
    // from contaminating the server-side conversation state.
    const session = await withTimeout(createSession(credentials, ORIGIN), "session creation");
    const challenge = await withTimeout(
      createPowChallenge(credentials, ORIGIN),
      "PoW challenge",
    );
    const solution = solvePow(challenge);
    const powHeader = encodePowResponse(solution);

    const headers = buildCompletionHeaders(credentials, powHeader, hifLeim);
    const request = {
      chat_session_id: session.id,
      parent_message_id: null,
      model_type: testCase.model_type,
      prompt: PROMPT,
      ref_file_ids: [],
      thinking_enabled: testCase.thinking_enabled,
      search_enabled: testCase.search_enabled,
      action: null,
      preempt: false,
    };

    const response = await withTimeout(
      fetch(`${ORIGIN}${DEEPSEEK.ENDPOINTS.COMPLETION}`, {
        method: "POST",
        headers,
        body: JSON.stringify(request),
      }),
      "completion request",
    );

    if (!response.ok) {
      const body = await response.text();
      return {
        ...testCase,
        status: "rejected",
        http_status: response.status,
        ready_model_type: null,
        request_message_id: null,
        response_message_id: null,
        search_enabled_observed: null,
        search_triggered: null,
        conversation_mode: null,
        error: body.slice(0, 1000),
      };
    }

    const result = await withTimeout(parseCompletionStream(response), "completion SSE parse");
    const serverModelType = rawReadyModel(result);

    assert.ok(serverModelType, "successful completion must contain ready.data.model_type");
    assert.notEqual(result.response_message_id, null, "successful completion must expose response_message_id");

    return {
      ...testCase,
      status: "success",
      http_status: response.status,
      ready_model_type: serverModelType,
      request_message_id: result.request_message_id,
      response_message_id: result.response_message_id,
      search_enabled_observed: result.search_enabled ?? null,
      search_triggered: result.search_triggered ?? null,
      conversation_mode: result.conversation_mode ?? null,
      error: null,
    };
  } catch (error) {
    return {
      ...testCase,
      status: "failed",
      http_status: null,
      ready_model_type: null,
      request_message_id: null,
      response_message_id: null,
      search_enabled_observed: null,
      search_triggered: null,
      conversation_mode: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function modelLabel(modelType: DeepSeekModelType): string {
  return modelType === null ? "null" : JSON.stringify(modelType);
}

function printResults(results: CaseResult[]): void {
  console.log("\nDeepSeek endpoint model/flag matrix");
  console.log("=================================");

  for (const result of results) {
    console.log(
      JSON.stringify({
        request: {
          model_type: result.model_type,
          thinking_enabled: result.thinking_enabled,
          search_enabled: result.search_enabled,
        },
        outcome: result.status,
        http_status: result.http_status,
        server_ready_model_type: result.ready_model_type,
        request_message_id: result.request_message_id,
        response_message_id: result.response_message_id,
        search_enabled_observed: result.search_enabled_observed,
        search_triggered: result.search_triggered,
        conversation_mode: result.conversation_mode,
        error: result.error,
      }),
    );
  }

  const successful = results.filter((result) => result.status === "success");
  const rejected = results.filter((result) => result.status === "rejected");
  const failed = results.filter((result) => result.status === "failed");

  const observedByRequestModel = new Map<string, Set<string>>();
  for (const result of successful) {
    const requestModel = modelLabel(result.model_type);
    const set = observedByRequestModel.get(requestModel) ?? new Set<string>();
    if (result.ready_model_type) set.add(result.ready_model_type);
    observedByRequestModel.set(requestModel, set);
  }

  console.log("\nSummary");
  console.log(`  cases: ${results.length}`);
  console.log(`  successful: ${successful.length}`);
  console.log(`  rejected by server: ${rejected.length}`);
  console.log(`  test/protocol failures: ${failed.length}`);
  console.log("  server model reports by request model:");
  for (const [requestModel, serverModels] of observedByRequestModel) {
    console.log(`    ${requestModel} -> ${JSON.stringify([...serverModels])}`);
  }

  if (failed.length > 0) {
    throw new Error(`${failed.length} matrix case(s) failed at the client/protocol level`);
  }

  assert.ok(successful.length > 0, "matrix must produce at least one successful completion");

  const validServerModels = successful.every(
    (result) => typeof result.ready_model_type === "string" && result.ready_model_type.length > 0,
  );
  assert.ok(validServerModels, "every successful completion must report a non-empty server model_type");
}

async function main(): Promise<void> {
  if (!requiredCredentialPresent()) {
    throw new Error(
      "Set DEEPSEEK_AUTHORIZATION and/or DEEPSEEK_COOKIE before running the live endpoint matrix",
    );
  }

  console.log(`Target: ${ORIGIN}${DEEPSEEK.ENDPOINTS.COMPLETION}`);
  console.log(`Matrix: ${buildMatrix().length} cases`);
  console.log("Fetching current HIF-LEIM value once for the matrix...");

  const hifLeim = await fetchHifLeim();
  const results: CaseResult[] = [];

  for (const testCase of buildMatrix()) {
    console.log(
      `Running model=${modelLabel(testCase.model_type)} thinking=${testCase.thinking_enabled} search=${testCase.search_enabled}`,
    );
    results.push(await runCase(hifLeim, testCase));
  }

  printResults(results);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
