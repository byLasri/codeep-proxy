# DeepSeek Web Endpoint Contract

## Version

```text
contract_version = "2.1"
protocol_target = "DeepSeek Web Chat"
runtime_reference = "Cloudflare Workers + TypeScript + Wrangler"
```

---

# 1. Reference implementation template

The following is the complete structural template of an implementation conforming to this contract.

It is intentionally written for Cloudflare Workers using standard Web APIs and TypeScript. It does not depend on a specific Node.js version.

```ts
export interface Env {
  DEEPSEEK_AUTHORIZATION?: string;
  DEEPSEEK_COOKIE?: string;
  DEEPSEEK_ORIGIN?: string;
}

export const DEEPSEEK = {
  ORIGIN: "https://chat.deepseek.com",
  ENDPOINTS: {
    CREATE_SESSION: "/api/v0/chat_session/create",
    CREATE_POW: "/api/v0/chat/create_pow_challenge",
    COMPLETION: "/api/v0/chat/completion",
  },
  CLIENT: {
    BUNDLE_ID: "com.deepseek.chat",
    PLATFORM: "web",
    VERSION: "2.4.0",
    LOCALE: "en_US",
  },
  POW: { ALGORITHM: "DeepSeekHashV1" },
} as const;

export type DeepSeekModelType = null | "expert" | string;

export interface DeepSeekCompletionRequest {
  chat_session_id: string;
  parent_message_id: number | null;
  model_type: DeepSeekModelType;
  prompt: string;
  ref_file_ids: string[];
  thinking_enabled: boolean;
  search_enabled: boolean;
  action: unknown | null;
  preempt: boolean;
}

export interface DeepSeekSession {
  id: string;
  seq_id?: number;
  agent?: string;
  model_type?: string | null;
  current_message_id?: number | null;
  ttl_seconds?: number;
  [key: string]: unknown;
}

export interface DeepSeekConversationState {
  chat_session_id: string;
  parent_message_id: number | null;
  model_type?: DeepSeekModelType;
  thinking_enabled?: boolean;
  search_enabled?: boolean;
  created_at?: number;
  updated_at?: number;
}

export interface DeepSeekPowChallenge {
  algorithm: string;
  challenge: string;
  salt: string;
  signature: string;
  difficulty: number;
  expire_at?: number;
  expire_after?: number;
  target_path: string;
  [key: string]: unknown;
}

export interface DeepSeekPowSolution { [key: string]: unknown; }
export interface DeepSeekReadyEvent {
  request_message_id: number;
  response_message_id: number;
  model_type: string;
}
export interface DeepSeekSSEEvent { event?: string; data?: unknown; }
export interface DeepSeekCompletionResult {
  request_message_id: number | null;
  response_message_id: number | null;
  model_type: string | null;
  output_text: string;
  search_enabled?: boolean;
  search_triggered?: boolean;
  conversation_mode?: string;
  events: DeepSeekSSEEvent[];
}

export interface DeepSeekClientHeaders {
  authorization?: string;
  cookie?: string;
  "x-client-bundle-id": string;
  "x-client-platform": string;
  "x-client-version": string;
  "x-client-locale": string;
  "x-client-timezone-offset": string;
  "x-hif-leim"?: string;
  "x-hif-dliq"?: string;
  "x-ds-pow-response"?: string;
  "content-type": string;
  accept: string;
}

export function buildAuthenticationHeaders(env: Env): Record<string, string> {
  const headers: Record<string, string> = {
    "x-client-bundle-id": DEEPSEEK.CLIENT.BUNDLE_ID,
    "x-client-platform": DEEPSEEK.CLIENT.PLATFORM,
    "x-client-version": DEEPSEEK.CLIENT.VERSION,
    "x-client-locale": DEEPSEEK.CLIENT.LOCALE,
    "x-client-timezone-offset": "3600",
    "content-type": "application/json",
    "accept": "*/*",
  };
  if (env.DEEPSEEK_AUTHORIZATION) headers["authorization"] = env.DEEPSEEK_AUTHORIZATION;
  if (env.DEEPSEEK_COOKIE) headers["cookie"] = env.DEEPSEEK_COOKIE;
  return headers;
}

export async function createChatSession(env: Env): Promise<DeepSeekSession> {
  const response = await fetch(`${DEEPSEEK.ORIGIN}${DEEPSEEK.ENDPOINTS.CREATE_SESSION}`, {
    method: "POST", headers: buildAuthenticationHeaders(env), body: JSON.stringify({}),
  });
  if (!response.ok) throw new Error(`DeepSeek session creation failed: HTTP ${response.status}`);
  return await response.json() as DeepSeekSession;
}

export async function createPowChallenge(env: Env): Promise<DeepSeekPowChallenge> {
  const response = await fetch(`${DEEPSEEK.ORIGIN}${DEEPSEEK.ENDPOINTS.CREATE_POW}`, {
    method: "POST",
    headers: buildAuthenticationHeaders(env),
    body: JSON.stringify({ target_path: DEEPSEEK.ENDPOINTS.COMPLETION }),
  });
  if (!response.ok) throw new Error(`DeepSeek PoW challenge failed: HTTP ${response.status}`);
  return await response.json() as DeepSeekPowChallenge;
}

export function buildCompletionRequest(
  state: DeepSeekConversationState,
  prompt: string,
  options: {
    model_type?: DeepSeekModelType;
    thinking_enabled?: boolean;
    search_enabled?: boolean;
    ref_file_ids?: string[];
    action?: unknown | null;
    preempt?: boolean;
  } = {},
): DeepSeekCompletionRequest {
  return {
    chat_session_id: state.chat_session_id,
    parent_message_id: state.parent_message_id,
    model_type: options.model_type ?? null,
    prompt,
    ref_file_ids: options.ref_file_ids ?? [],
    thinking_enabled: options.thinking_enabled ?? false,
    search_enabled: options.search_enabled ?? false,
    action: options.action ?? null,
    preempt: options.preempt ?? false,
  };
}

export async function requestCompletion(
  env: Env,
  request: DeepSeekCompletionRequest,
  powHeader: string,
  hifHeaders: Partial<Pick<DeepSeekClientHeaders, "x-hif-leim" | "x-hif-dliq">> = {},
): Promise<Response> {
  const headers = buildAuthenticationHeaders(env);
  headers["accept"] = "text/event-stream";
  headers["x-ds-pow-response"] = powHeader;
  if (hifHeaders["x-hif-leim"]) headers["x-hif-leim"] = hifHeaders["x-hif-leim"]!;
  if (hifHeaders["x-hif-dliq"]) headers["x-hif-dliq"] = hifHeaders["x-hif-dliq"]!;
  return fetch(`${DEEPSEEK.ORIGIN}${DEEPSEEK.ENDPOINTS.COMPLETION}`, {
    method: "POST", headers, body: JSON.stringify(request),
  });
}
```

The template defines the protocol surface without coupling it to a particular application architecture.

---

# 2. Protocol definition

## 2.1 Origin

```json
{
  "name": "DeepSeek Web API origin",
  "value": "https://chat.deepseek.com",
  "status": "ESTABLISHED"
}
```

The protocol endpoints documented below are relative to this origin.

---

# 3. Endpoint specification

## 3.1 Chat-session creation

```json
{
  "method": "POST",
  "path": "/api/v0/chat_session/create",
  "request_content_type": "application/json",
  "request_body": {},
  "response_type": "JSON",
  "purpose": "Create a new DeepSeek chat session",
  "status": "ESTABLISHED"
}
```

The returned session contains an `id` used as `chat_session_id`.

---

# 4. Chat session

```json
{
  "name": "chat_session_id",
  "type": "string",
  "source": "chat_session/create.id",
  "scope": "conversation",
  "status": "ESTABLISHED"
}
```

A chat session is the server-side container for a conversation. Sequential turns of the same conversation reuse the session identifier.

---

# 5. Session lifetime

Observed session metadata includes:

```json
{
  "field": "ttl_seconds",
  "observed_value": 259200,
  "equivalent": "3 days",
  "status": "OBSERVED"
}
```

Exact expiration behavior remains a server property beyond the observed metadata.

---

# 6. Completion endpoint

```json
{
  "method": "POST",
  "path": "/api/v0/chat/completion",
  "request_content_type": "application/json",
  "response_content_type": "text/event-stream",
  "purpose": "Generate a DeepSeek chat response",
  "status": "ESTABLISHED"
}
```

---

# 7. Completion request schema

```json
{
  "chat_session_id": { "type": "string", "required": true },
  "parent_message_id": { "type": "number|null", "required": true },
  "model_type": { "type": "string|null", "required": true, "observed_values": [null, "expert"] },
  "prompt": { "type": "string", "required": true },
  "ref_file_ids": { "type": "array", "required": true, "normal_value": [] },
  "thinking_enabled": { "type": "boolean", "required": true },
  "search_enabled": { "type": "boolean", "required": true },
  "action": { "type": "null|unknown", "required": true, "normal_value": null },
  "preempt": { "type": "boolean", "required": true, "normal_value": false }
}
```

---

# 8. parent_message_id

```json
{
  "name": "parent_message_id",
  "type": "number|null",
  "first_turn": null,
  "subsequent_turn": "previous response_message_id",
  "status": "ESTABLISHED"
}
```

---

# 9. Message-chain state

The minimum conversational state is:

```json
{
  "chat_session_id": "string",
  "parent_message_id": "number|null"
}
```

A session identifier alone is not the complete continuation state.

---

# 10. Message identifiers

The completion protocol exposes `request_message_id` and `response_message_id`. The authoritative new assistant response identifier is supplied by the `ready` event.

---

# 11. SSE response contract

The completion response is an SSE stream. Relevant event classes include `ready`, `update_session`, `data`, and `close`.

---

# 12. ready event

```json
{
  "event": "ready",
  "data": {
    "request_message_id": "number",
    "response_message_id": "number",
    "model_type": "string"
  },
  "status": "ESTABLISHED"
}
```

---

# 13. State transition caused by ready

```json
{
  "before": { "parent_message_id": "previous response ID or null" },
  "ready": { "response_message_id": "new response ID" },
  "after": { "parent_message_id": "ready.response_message_id" }
}
```

---

# 14. SSE delta protocol

Observed content deltas use fields equivalent to:

```json
{ "p": "response/fragments/-1/content", "o": "APPEND", "v": "text" }
```

Observed operations include `SET`, `APPEND`, and `BATCH`.

---

# 15. Model type

```json
{
  "field": "model_type",
  "type": "string|null",
  "observed_values": [null, "expert"]
}
```

Observed interpretation: `null` is the default/Flash path; `expert` is the Pro/expert path.

---

# 16. Default model

Observed wire representation:

```json
{ "model_type": null }
```

The server may report `model_type: "default"`.

---

# 17. Expert model

Observed wire representation:

```json
{ "model_type": "expert" }
```

---

# 18. Thinking mode

```json
{
  "field": "thinking_enabled",
  "type": "boolean",
  "values": [false, true],
  "status": "ESTABLISHED"
}
```

---

# 19. Model/reasoning matrix

```json
[
  { "model_type": null, "thinking_enabled": false, "description": "default / Flash without thinking" },
  { "model_type": null, "thinking_enabled": true, "description": "default / Flash with thinking" },
  { "model_type": "expert", "thinking_enabled": false, "description": "expert / Pro without thinking" },
  { "model_type": "expert", "thinking_enabled": true, "description": "expert / Pro with thinking" }
]
```

---

# 20. Search mode

```json
{
  "field": "search_enabled",
  "type": "boolean",
  "values": [false, true]
}
```

Search uses the same `/api/v0/chat/completion` endpoint.

---

# 21. Search response state

Observed search-related response information includes:

```json
{
  "search_enabled": true,
  "search_triggered": true,
  "conversation_mode": "DEEP_SEARCH"
}
```

---

# 22. Combined model/search/thinking state

These are independent request dimensions:

```json
{
  "model_type": null,
  "thinking_enabled": true,
  "search_enabled": true
}
```

---

# 23. PoW endpoint

```json
{
  "method": "POST",
  "path": "/api/v0/chat/create_pow_challenge",
  "request_body": { "target_path": "/api/v0/chat/completion" },
  "response": "PoW challenge object",
  "status": "ESTABLISHED"
}
```

---

# 24. PoW challenge schema

Observed fields include `algorithm`, `challenge`, `salt`, `signature`, `difficulty`, expiration information, and `target_path`. The observed algorithm is `DeepSeekHashV1`.

---

# 25. PoW response

The completion request includes `x-ds-pow-response`, carrying the solved PoW result.

---

# 26. PoW binding

The challenge includes `target_path: "/api/v0/chat/completion"`, explicitly associating the challenge with completion.

---

# 27. Browser client headers

Observed client metadata:

```json
{
  "x-client-bundle-id": "com.deepseek.chat",
  "x-client-platform": "web",
  "x-client-version": "2.4.0",
  "x-client-locale": "en_US",
  "x-client-timezone-offset": "3600"
}
```

These are observed browser values and should not automatically be interpreted as immutable server requirements.

---

# 28. Authentication headers

Authenticated requests carry authorization and browser session state:

```json
{
  "Authorization": "authenticated session",
  "Cookie": "authenticated browser state"
}
```

Credentials must not be embedded into protocol documentation.

---

# 29. Authentication/session boundary

The protocol distinguishes authentication, the conversation session, and the message-chain position.

---

# 30. ref_file_ids

Normal observed text completion:

```json
{ "ref_file_ids": [] }
```

The complete attachment protocol is not defined by the current text-only contract.

---

# 31. action

Normal observed request:

```json
{ "action": null }
```

Non-null action values remain unspecified.

---

# 32. preempt

Normal observed request:

```json
{ "preempt": false }
```

The semantics of `preempt=true` remain unknown.

---

# 33. Conversation continuation

The canonical continuation state is:

```json
{
  "chat_session_id": "<same-session>",
  "parent_message_id": "<previous response_message_id>"
}
```

---

# 34. Model switching

Model switching within an existing session remains provisional. The request schema can represent it, but complete server semantics are not yet established.

---

# 35. Session-scoped versus request-scoped state

```json
{
  "chat_session_id": { "scope": "session" },
  "parent_message_id": { "scope": "message chain" },
  "model_type": { "scope": "request", "session_switching": "provisional" },
  "thinking_enabled": { "scope": "request" },
  "search_enabled": { "scope": "request" }
}
```

---

# 36. Complete normal request

```json
{
  "chat_session_id": "<uuid>",
  "parent_message_id": null,
  "model_type": null,
  "prompt": "<text>",
  "ref_file_ids": [],
  "thinking_enabled": false,
  "search_enabled": false,
  "action": null,
  "preempt": false
}
```

---

# 37. Complete continuation request

```json
{
  "chat_session_id": "<same-uuid>",
  "parent_message_id": 42,
  "model_type": null,
  "prompt": "<next-text>",
  "ref_file_ids": [],
  "thinking_enabled": false,
  "search_enabled": false,
  "action": null,
  "preempt": false
}
```

---

# 38. Complete expert request

```json
{
  "chat_session_id": "<uuid>",
  "parent_message_id": 42,
  "model_type": "expert",
  "prompt": "<text>",
  "ref_file_ids": [],
  "thinking_enabled": true,
  "search_enabled": false,
  "action": null,
  "preempt": false
}
```

---

# 39. Complete search request

```json
{
  "chat_session_id": "<uuid>",
  "parent_message_id": 42,
  "model_type": null,
  "prompt": "<search-question>",
  "ref_file_ids": [],
  "thinking_enabled": true,
  "search_enabled": true,
  "action": null,
  "preempt": false
}
```

---

# 40. Complete response state

A completed response should yield at minimum:

```json
{
  "request_message_id": 43,
  "response_message_id": 44,
  "model_type": "default"
}
```

The next `parent_message_id` is `44`.

---

# 41. Protocol state machine

```json
{
  "states": ["UNAUTHENTICATED", "AUTHENTICATED", "SESSION_CREATED", "COMPLETION_STARTED", "READY", "STREAMING", "COMPLETED", "FAILED"],
  "transitions": [
    { "from": "AUTHENTICATED", "operation": "chat_session/create", "to": "SESSION_CREATED" },
    { "from": "SESSION_CREATED", "operation": "create_pow_challenge", "to": "SESSION_CREATED" },
    { "from": "SESSION_CREATED", "operation": "chat/completion", "to": "COMPLETION_STARTED" },
    { "from": "COMPLETION_STARTED", "event": "ready", "to": "READY" },
    { "from": "READY", "event": "content delta", "to": "STREAMING" },
    { "from": "STREAMING", "event": "close", "to": "COMPLETED" }
  ]
}
```

---

# 42. Continuation invariant

```json
{
  "invariant": "NEXT_PARENT_EQUALS_PREVIOUS_RESPONSE",
  "rule": "next.parent_message_id === previous.ready.response_message_id",
  "status": "ESTABLISHED"
}
```

---

# 43. Session invariant

```json
{
  "invariant": "SESSION_STABILITY",
  "rule": "sequential turns in one conversation reuse the same chat_session_id",
  "status": "ESTABLISHED"
}
```

---

# 44. Message identity invariant

```json
{
  "invariant": "READY_IS_AUTHORITATIVE",
  "rule": "ready.response_message_id is the authoritative continuation response ID",
  "status": "ESTABLISHED"
}
```

---

# 45. Model invariant

```json
{
  "invariant": "MODEL_IS_A_REQUEST_DIMENSION",
  "rule": "model_type is transmitted independently of thinking_enabled and search_enabled",
  "status": "ESTABLISHED"
}
```

---

# 46. Search invariant

```json
{
  "invariant": "SEARCH_IS_A_REQUEST_DIMENSION",
  "rule": "search_enabled is transmitted through /api/v0/chat/completion",
  "status": "ESTABLISHED"
}
```

---

# 47. Thinking invariant

```json
{
  "invariant": "THINKING_IS_A_BOOLEAN",
  "rule": "thinking_enabled is represented as a boolean request field",
  "status": "ESTABLISHED"
}
```

---

# 48. HIF side-channel

HIF (High-Integrity Framework) values are obtained from dedicated DeepSeek side-channel origins.

```json
[
  {
    "header": "x-hif-leim",
    "method": "GET",
    "origin": "https://hif-leim.deepseek.com",
    "path": "/query",
    "purpose": "Fetch LEIM HIF token",
    "status": "ESTABLISHED"
  },
  {
    "header": "x-hif-dliq",
    "method": "GET",
    "origin": "https://hif-dliq.deepseek.com",
    "path": "/query",
    "purpose": "Fetch DLIQ HIF token for multimodal requests",
    "status": "ESTABLISHED"
  }
]
```

The tokens are not generated by the browser client.

---

# 49. HIF request headers

The observed side-channel requests use authenticated browser-client context:

```json
{
  "Authorization": "Bearer <user_token>",
  "Origin": "https://chat.deepseek.com",
  "Referer": "https://chat.deepseek.com/",
  "User-Agent": "<browser user agent>"
}
```

The exact credential value is account-specific and must never be documented or committed.

---

# 50. HIF response

The token is extracted from:

```text
data.biz_data.value
```

Observed response shape:

```json
{
  "code": 0,
  "data": {
    "biz_data": {
      "value": "<HIF token>"
    }
  }
}
```

The token is treated as opaque runtime data; its internal encoding and signing algorithm are not established by this contract.

---

# 51. HIF lifetime and caching

HAR telemetry establishes a HIF TTL of 600 seconds.

```json
{
  "ttl_seconds": 600,
  "equivalent": "10 minutes",
  "recommended_refresh_before_expiry": 480
}
```

Implementations should cache HIF values and refresh them before expiry rather than fetching them for every completion.

Canonical state:

```json
{
  "leim": "string",
  "dliq": "string",
  "expires_at": "number (epoch ms)"
}
```

---

# 52. HIF injection

When HIF is available for a completion request, the values are supplied as headers:

```json
{
  "target_endpoint": "/api/v0/chat/completion",
  "headers": {
    "x-hif-leim": "<LEIM token>",
    "x-hif-dliq": "<DLIQ token>"
  }
}
```

HIF tokens must be treated as sensitive runtime state.

---

# 53. HIF enforcement

Observed enforcement is conditional on the requested model dimension:

```json
[
  {
    "model_type": null,
    "hif_requirement": "SOFT_FAIL",
    "observed_behavior": "text completion can succeed without HIF"
  },
  {
    "model_type": "expert",
    "hif_requirement": "SOFT_FAIL",
    "observed_behavior": "expert completion can succeed without HIF"
  },
  {
    "model_type": "vision",
    "hif_requirement": "STRICT",
    "observed_behavior": "missing HIF may produce unsupported_client_by_model"
  }
]
```

HIF is therefore part of the recognized web-client protocol, but server enforcement is request/model dependent.

---

# 54. HIF proxy flow

A proxy obtains HIF values through the side channels and then injects them into the primary request when applicable:

```text
authenticated credentials
        |
        +--> GET hif-leim.deepseek.com/query
        |       |
        |       +--> data.biz_data.value --> LEIM cache
        |
        +--> GET hif-dliq.deepseek.com/query
                |
                +--> data.biz_data.value --> DLIQ cache

cached HIF values
        |
        +--> x-hif-leim
        +--> x-hif-dliq
                |
                v
POST chat.deepseek.com/api/v0/chat/completion
```

The proxy must not generate the tokens locally.

---

# 55. HIF implementation state

```json
{
  "state": {
    "leim": "string|null",
    "dliq": "string|null",
    "expires_at": "number|null"
  },
  "refresh_policy": "refresh before expiry",
  "ttl_seconds": 600
}
```

A single cached state may be reused for sequential requests belonging to the same authenticated context, subject to observed token scope and expiry.

---

# 56. Remaining HIF questions

The following are not asserted beyond the current evidence:

```json
[
  "internal HIF token format",
  "cryptographic signing algorithm",
  "exact account/device binding semantics",
  "exact behavior after token expiry",
  "whether every browser text completion includes HIF",
  "complete DLIQ enforcement outside multimodal requests"
]
```

---

# 57. Unknown protocol surface

The current contract intentionally leaves the following unspecified:

```json
{
  "unknown": [
    "complete model_type enumeration",
    "non-null action schema",
    "preempt=true semantics",
    "file attachment protocol",
    "complete session-expiration behavior",
    "complete error-code enumeration",
    "exact PoW reuse rules",
    "exact semantics of every SSE event",
    "full semantics of every response field",
    "complete server-side model-switch rules"
  ]
}
```

Unknown does not mean unsupported. It means the current contract does not establish the behavior.

---

# 58. Provisional protocol surface

```json
{
  "provisional": [
    {
      "feature": "mid-session default/expert switching",
      "known": "request schema can represent it",
      "unknown": "server semantic support"
    },
    {
      "feature": "non-null action",
      "known": "action field exists",
      "unknown": "supported values"
    },
    {
      "feature": "preempt=true",
      "known": "boolean field exists",
      "unknown": "server semantics"
    }
  ]
}
```

---

# 59. Conformance requirements

An implementation claiming conformance must preserve the core session, continuation, model, reasoning, search, PoW, SSE, and HIF behaviors established by this document.

In particular:

```json
{
  "requirements": [
    "use /api/v0/chat_session/create for session creation",
    "use /api/v0/chat/completion for completion",
    "use null parent_message_id on the first turn",
    "use the previous response_message_id on subsequent turns",
    "obtain the authoritative response_message_id from ready",
    "support model_type null/default and expert representations",
    "support thinking_enabled and search_enabled booleans",
    "include ref_file_ids",
    "perform the required PoW flow",
    "send x-ds-pow-response",
    "process completion as SSE",
    "support HIF side-channel acquisition when required",
    "cache HIF values rather than fetching them for every completion"
  ]
}
```

---

# 60. Protocol versus implementation

This document defines the observed DeepSeek wire protocol. It does not define application architecture, database architecture, proxy API design, or secret-storage implementation.

A conforming implementation may use Cloudflare Workers, Python, Java, Go, Rust, Node.js, or browser JavaScript provided that wire behavior remains conformant.

---

# 61. Cloudflare Workers reference requirements

```json
{
  "runtime": "Cloudflare Workers",
  "language": "TypeScript",
  "tooling": "Wrangler",
  "required_web_platform_features": [
    "fetch",
    "Request",
    "Response",
    "ReadableStream",
    "TextDecoder",
    "TextEncoder"
  ]
}
```

---

# 62. Security boundary

Authentication credentials and HIF tokens are sensitive runtime data. They must not appear in debug logs, protocol examples, source-controlled fixtures, or public documentation unless explicitly redacted.

---

# 63. Canonical protocol object

```json
{
  "deepseek_web_protocol": {
    "origin": "https://chat.deepseek.com",
    "session": {
      "create": {
        "method": "POST",
        "path": "/api/v0/chat_session/create",
        "body": {}
      }
    },
    "pow": {
      "create": {
        "method": "POST",
        "path": "/api/v0/chat/create_pow_challenge"
      },
      "algorithm": "DeepSeekHashV1",
      "header": "x-ds-pow-response"
    },
    "hif": {
      "leim_origin": "https://hif-leim.deepseek.com",
      "dliq_origin": "https://hif-dliq.deepseek.com",
      "path": "/query",
      "method": "GET",
      "extraction_path": "data.biz_data.value",
      "ttl_seconds": 600,
      "injection_headers": ["x-hif-leim", "x-hif-dliq"]
    },
    "completion": {
      "method": "POST",
      "path": "/api/v0/chat/completion",
      "response": "SSE"
    },
    "request": {
      "chat_session_id": "string",
      "parent_message_id": "number|null",
      "model_type": "null|expert",
      "prompt": "string",
      "ref_file_ids": "array",
      "thinking_enabled": "boolean",
      "search_enabled": "boolean",
      "action": "null|unknown",
      "preempt": "boolean"
    },
    "continuation": {
      "first_parent_message_id": null,
      "next_parent_message_id": "previous response_message_id"
    },
    "ready": {
      "request_message_id": "number",
      "response_message_id": "number",
      "model_type": "string"
    },
    "client_headers": {
      "x-client-bundle-id": "com.deepseek.chat",
      "x-client-platform": "web",
      "x-client-version": "2.4.0",
      "x-client-locale": "en_US",
      "x-client-timezone-offset": "3600",
      "x-hif-leim": "HIF side-channel token",
      "x-hif-dliq": "HIF side-channel token"
    }
  }
}
```

---

# 64. Canonical interpretation

The DeepSeek Web protocol consists of conversation state, model/reasoning/search dimensions, common completion properties, authentication/client headers, PoW, HIF side channels, and SSE response processing.

HIF values are obtained from separate authenticated services and may then be supplied to the primary completion request. They are not client-generated signatures.

---

# 65. Contract status

```json
{
  "overall_status": "PARTIALLY_ESTABLISHED",
  "core_completion_protocol": "ESTABLISHED",
  "conversation_continuity": "ESTABLISHED",
  "default_model": "ESTABLISHED",
  "expert_model": "ESTABLISHED",
  "thinking": "ESTABLISHED",
  "search": "ESTABLISHED",
  "pow": "ESTABLISHED",
  "sse_ready": "ESTABLISHED",
  "hif_side_channel": "ESTABLISHED",
  "hif_ttl": "ESTABLISHED (600 seconds observed)",
  "hif_text_enforcement": "ESTABLISHED (SOFT_FAIL observed)",
  "hif_vision_enforcement": "ESTABLISHED (STRICT behavior observed)",
  "mid_session_model_switch": "PROVISIONAL",
  "non_null_action": "UNKNOWN",
  "preempt_true": "UNKNOWN",
  "file_protocol": "UNKNOWN"
}
```

---

# 66. Normative rule

The governing rule of this specification is:

```text
A browser-observed value defines what the browser sends.

A validated server behavior defines what the protocol accepts.

An inferred behavior must remain marked as inferred.

An unestablished behavior must remain unknown or provisional.

No implementation assumption becomes a DeepSeek protocol rule merely because an implementation chooses to use it.
```

This document represents the observed DeepSeek Web protocol, with Cloudflare Workers TypeScript serving as the reference implementation form.
