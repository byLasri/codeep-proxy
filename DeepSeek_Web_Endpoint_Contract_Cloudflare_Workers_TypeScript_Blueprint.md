# DeepSeek Web Endpoint Contract

## Version

```text
contract_version = "2.0"
protocol_target = "DeepSeek Web Chat"
runtime_reference = "Cloudflare Workers + TypeScript + Wrangler"
```

---

# 1. Reference implementation template

The following is the complete structural template of an implementation conforming to this contract.

It is intentionally written for Cloudflare Workers using standard Web APIs and TypeScript. It does not depend on a specific Node.js version.

```ts
// ============================================================
// DeepSeek Web Protocol — Cloudflare Workers Reference Template
// ============================================================

// ------------------------------------------------------------
// 1. Environment
// ------------------------------------------------------------

export interface Env {
  DEEPSEEK_AUTHORIZATION?: string;
  DEEPSEEK_COOKIE?: string;

  // Optional protocol/runtime configuration.
  DEEPSEEK_ORIGIN?: string;
}

// ------------------------------------------------------------
// 2. Protocol constants
// ------------------------------------------------------------

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

  POW: {
    ALGORITHM: "DeepSeekHashV1",
  },
} as const;

// ------------------------------------------------------------
// 3. Core protocol types
// ------------------------------------------------------------

export type DeepSeekModelType =
  | null
  | "expert"
  | string;

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

// ------------------------------------------------------------
// 4. Conversation state
// ------------------------------------------------------------

export interface DeepSeekConversationState {
  chat_session_id: string;
  parent_message_id: number | null;

  model_type?: DeepSeekModelType;
  thinking_enabled?: boolean;
  search_enabled?: boolean;

  created_at?: number;
  updated_at?: number;
}

// ------------------------------------------------------------
// 5. PoW types
// ------------------------------------------------------------

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

export interface DeepSeekPowSolution {
  [key: string]: unknown;
}

// ------------------------------------------------------------
// 6. SSE types
// ------------------------------------------------------------

export interface DeepSeekReadyEvent {
  request_message_id: number;
  response_message_id: number;
  model_type: string;
}

export interface DeepSeekSSEEvent {
  event?: string;
  data?: unknown;
}

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

// ------------------------------------------------------------
// 7. Protocol errors
// ------------------------------------------------------------

export type DeepSeekErrorKind =
  | "authentication"
  | "session"
  | "pow"
  | "completion"
  | "sse"
  | "protocol"
  | "unknown";

export interface DeepSeekError {
  kind: DeepSeekErrorKind;
  http_status?: number;
  code?: string | number | null;
  message?: string;
  raw?: unknown;
}

// ------------------------------------------------------------
// 8. Header construction
// ------------------------------------------------------------

export interface DeepSeekClientHeaders {
  authorization?: string;
  cookie?: string;

  "x-client-bundle-id": string;
  "x-client-platform": string;
  "x-client-version": string;
  "x-client-locale": string;
  "x-client-timezone-offset": string;

  "x-hif-leim"?: string;
  "x-ds-pow-response"?: string;

  "content-type": string;
  accept: string;
}

// ------------------------------------------------------------
// 9. Authentication
// ------------------------------------------------------------

export function buildAuthenticationHeaders(
  env: Env,
): Record<string, string> {
  const headers: Record<string, string> = {
    "x-client-bundle-id": DEEPSEEK.CLIENT.BUNDLE_ID,
    "x-client-platform": DEEPSEEK.CLIENT.PLATFORM,
    "x-client-version": DEEPSEEK.CLIENT.VERSION,
    "x-client-locale": DEEPSEEK.CLIENT.LOCALE,

    // Exact wire representation required by the protocol.
    "x-client-timezone-offset": "3600",

    "content-type": "application/json",
    "accept": "*/*",
  };

  if (env.DEEPSEEK_AUTHORIZATION) {
    headers["authorization"] = env.DEEPSEEK_AUTHORIZATION;
  }

  if (env.DEEPSEEK_COOKIE) {
    headers["cookie"] = env.DEEPSEEK_COOKIE;
  }

  return headers;
}

// ------------------------------------------------------------
// 10. Session creation
// ------------------------------------------------------------

export async function createChatSession(
  env: Env,
): Promise<DeepSeekSession> {
  const response = await fetch(
    `${DEEPSEEK.ORIGIN}${DEEPSEEK.ENDPOINTS.CREATE_SESSION}`,
    {
      method: "POST",
      headers: buildAuthenticationHeaders(env),
      body: JSON.stringify({}),
    },
  );

  if (!response.ok) {
    throw new Error(
      `DeepSeek session creation failed: HTTP ${response.status}`,
    );
  }

  return await response.json() as DeepSeekSession;
}

// ------------------------------------------------------------
// 11. PoW challenge
// ------------------------------------------------------------

export async function createPowChallenge(
  env: Env,
): Promise<DeepSeekPowChallenge> {
  const response = await fetch(
    `${DEEPSEEK.ORIGIN}${DEEPSEEK.ENDPOINTS.CREATE_POW}`,
    {
      method: "POST",
      headers: buildAuthenticationHeaders(env),
      body: JSON.stringify({
        target_path: DEEPSEEK.ENDPOINTS.COMPLETION,
      }),
    },
  );

  if (!response.ok) {
    throw new Error(
      `DeepSeek PoW challenge failed: HTTP ${response.status}`,
    );
  }

  return await response.json() as DeepSeekPowChallenge;
}

// ------------------------------------------------------------
// 12. PoW solver
// ------------------------------------------------------------

export async function solvePow(
  challenge: DeepSeekPowChallenge,
): Promise<DeepSeekPowSolution> {
  if (challenge.algorithm !== DEEPSEEK.POW.ALGORITHM) {
    throw new Error(
      `Unsupported PoW algorithm: ${challenge.algorithm}`,
    );
  }

  // DeepSeekHashV1 implementation goes here.
  // Exact algorithm is a protocol component.
  return {};
}

// ------------------------------------------------------------
// 13. Completion request builder
// ------------------------------------------------------------

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

    parent_message_id:
      state.parent_message_id,

    model_type:
      options.model_type ?? null,

    prompt,

    ref_file_ids:
      options.ref_file_ids ?? [],

    thinking_enabled:
      options.thinking_enabled ?? false,

    search_enabled:
      options.search_enabled ?? false,

    action:
      options.action ?? null,

    preempt:
      options.preempt ?? false,
  };
}

// ------------------------------------------------------------
// 14. Completion request
// ------------------------------------------------------------

export async function requestCompletion(
  env: Env,
  request: DeepSeekCompletionRequest,
  powHeader: string,
): Promise<Response> {
  const headers = buildAuthenticationHeaders(env);

  headers["accept"] = "text/event-stream";
  headers["x-ds-pow-response"] = powHeader;

  return fetch(
    `${DEEPSEEK.ORIGIN}${DEEPSEEK.ENDPOINTS.COMPLETION}`,
    {
      method: "POST",
      headers,
      body: JSON.stringify(request),
    },
  );
}

// ------------------------------------------------------------
// 15. SSE parsing
// ------------------------------------------------------------

export async function parseCompletionStream(
  response: Response,
): Promise<DeepSeekCompletionResult> {
  if (!response.body) {
    throw new Error("DeepSeek completion response has no body");
  }

  // SSE parser implementation goes here.
  // It must separately process:
  //   - event: ready
  //   - event: update_session
  //   - data deltas
  //   - event: close

  return {
    request_message_id: null,
    response_message_id: null,
    model_type: null,
    output_text: "",
    events: [],
  };
}

// ------------------------------------------------------------
// 16. Complete one turn
// ------------------------------------------------------------

export async function completeTurn(
  env: Env,
  state: DeepSeekConversationState,
  prompt: string,
  options: {
    model_type?: DeepSeekModelType;
    thinking_enabled?: boolean;
    search_enabled?: boolean;
  } = {},
): Promise<{
  result: DeepSeekCompletionResult;
  nextState: DeepSeekConversationState;
}> {
  const request = buildCompletionRequest(
    state,
    prompt,
    options,
  );

  const challenge =
    await createPowChallenge(env);

  const solution =
    await solvePow(challenge);

  const powHeader =
    btoa(JSON.stringify(solution));

  const response =
    await requestCompletion(
      env,
      request,
      powHeader,
    );

  if (!response.ok) {
    throw new Error(
      `DeepSeek completion failed: HTTP ${response.status}`,
    );
  }

  const result =
    await parseCompletionStream(response);

  if (result.response_message_id === null) {
    throw new Error(
      "DeepSeek completion did not provide response_message_id",
    );
  }

  const nextState: DeepSeekConversationState = {
    ...state,
    parent_message_id:
      result.response_message_id,

    model_type:
      options.model_type ?? state.model_type,

    thinking_enabled:
      options.thinking_enabled ??
      state.thinking_enabled,

    search_enabled:
      options.search_enabled ??
      state.search_enabled,

    updated_at: Date.now(),
  };

  return {
    result,
    nextState,
  };
}

// ------------------------------------------------------------
// 17. Worker entry point
// ------------------------------------------------------------

export default {
  async fetch(
    request: Request,
    env: Env,
  ): Promise<Response> {
    try {
      // Application-specific routing goes here.
      return new Response(
        "DeepSeek protocol implementation",
        { status: 200 },
      );
    } catch (error) {
      return new Response(
        JSON.stringify({
          error:
            error instanceof Error
              ? error.message
              : String(error),
        }),
        {
          status: 500,
          headers: {
            "content-type":
              "application/json",
          },
        },
      );
    }
  },
};
```

The template above defines the complete protocol surface without coupling it to a particular application architecture.

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

The returned session contains an identifier:

```json
{
  "field": "id",
  "type": "string",
  "semantic_role": "chat_session_id",
  "status": "ESTABLISHED"
}
```

Observed session metadata includes:

```json
{
  "id": "string",
  "seq_id": "number",
  "agent": "string",
  "model_type": "string|null",
  "current_message_id": "number|null",
  "ttl_seconds": "number"
}
```

Fields beyond `id` should be treated according to their observed presence rather than assumed to be universally required.

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

A chat session is the server-side container for a conversation.

The same session identifier is reused across sequential turns of the same browser conversation.

---

# 5. Session lifetime

Observed:

```json
{
  "field": "ttl_seconds",
  "observed_value": 259200,
  "seconds": 259200,
  "equivalent": "3 days",
  "status": "OBSERVED"
}
```

The existence of a finite TTL establishes that session identifiers are not permanent.

Exact expiration behavior remains a property of the server contract beyond the observed metadata.

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
  "chat_session_id": {
    "type": "string",
    "required": true
  },
  "parent_message_id": {
    "type": "number|null",
    "required": true
  },
  "model_type": {
    "type": "string|null",
    "required": true,
    "observed_values": [
      null,
      "expert"
    ]
  },
  "prompt": {
    "type": "string",
    "required": true
  },
  "ref_file_ids": {
    "type": "array",
    "required": true,
    "normal_value": []
  },
  "thinking_enabled": {
    "type": "boolean",
    "required": true
  },
  "search_enabled": {
    "type": "boolean",
    "required": true
  },
  "action": {
    "type": "null|unknown",
    "required": true,
    "normal_value": null
  },
  "preempt": {
    "type": "boolean",
    "required": true,
    "normal_value": false
  }
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

The field identifies the message from which the new user message continues.

For the first message:

```json
{
  "parent_message_id": null
}
```

For the next turn:

```json
{
  "parent_message_id": 42
}
```

where `42` is the previous assistant `response_message_id`.

---

# 9. Message-chain state

The protocol's minimum conversational state is:

```json
{
  "chat_session_id": "string",
  "parent_message_id": "number|null"
}
```

Equivalent semantic definition:

```json
{
  "chat_session_id": {
    "role": "conversation container"
  },
  "parent_message_id": {
    "role": "current conversation position"
  }
}
```

A session identifier by itself is therefore not the complete continuation state.

---

# 10. Message identifiers

The completion protocol exposes:

```json
{
  "request_message_id": "number",
  "response_message_id": "number"
}
```

Their roles are:

```json
{
  "request_message_id": "new user/request message identifier",
  "response_message_id": "new assistant response identifier"
}
```

The authoritative source for the new assistant response identifier is the `ready` event.

---

# 11. SSE response contract

The completion response is an SSE stream.

Relevant event classes include:

```json
{
  "event_types": [
    "ready",
    "update_session",
    "data",
    "close"
  ]
}
```

The exact event ordering belongs to the response protocol.

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

Example:

```text
event: ready
data: {
  "request_message_id": 1,
  "response_message_id": 2,
  "model_type": "default"
}
```

The `response_message_id` becomes the parent identifier for the next conversational request.

---

# 13. State transition caused by ready

```json
{
  "before": {
    "parent_message_id": "previous response ID or null"
  },
  "ready": {
    "response_message_id": "new response ID"
  },
  "after": {
    "parent_message_id": "ready.response_message_id"
  }
}
```

This is a protocol state transition, not merely response metadata.

---

# 14. SSE delta protocol

Observed content deltas use fields equivalent to:

```json
{
  "p": "response/fragments/-1/content",
  "o": "APPEND",
  "v": "text"
}
```

Field definitions:

```json
{
  "p": {
    "meaning": "path"
  },
  "o": {
    "meaning": "operation"
  },
  "v": {
    "meaning": "value"
  }
}
```

Observed operations:

```json
[
  "SET",
  "APPEND",
  "BATCH"
]
```

The delta protocol is independent from message-ID assignment.

---

# 15. Model type

The request-level field is:

```json
{
  "field": "model_type",
  "type": "string|null"
}
```

Observed request representations:

```json
[
  null,
  "expert"
]
```

Observed interpretation:

```json
{
  "null": "default / Flash path",
  "expert": "Pro / expert path"
}
```

The UI names and the protocol values must remain separate concepts.

---

# 16. Default model

Observed wire representation:

```json
{
  "model_type": null
}
```

The server may report:

```json
{
  "model_type": "default"
}
```

Therefore:

```json
{
  "request_model_type": null,
  "server_reported_model_type": "default"
}
```

is a valid observed transformation.

---

# 17. Expert model

Observed wire representation:

```json
{
  "model_type": "expert"
}
```

This corresponds to the observed Pro path.

---

# 18. Thinking mode

```json
{
  "field": "thinking_enabled",
  "type": "boolean",
  "values": [
    false,
    true
  ],
  "status": "ESTABLISHED"
}
```

Current semantic representation:

```json
{
  "false": "thinking disabled",
  "true": "thinking enabled"
}
```

No native DeepSeek request field corresponding directly to external terms such as:

```text
low
medium
high
max
```

is established by the current protocol captures.

---

# 19. Model/reasoning matrix

```json
[
  {
    "model_type": null,
    "thinking_enabled": false,
    "description": "default / Flash without thinking"
  },
  {
    "model_type": null,
    "thinking_enabled": true,
    "description": "default / Flash with thinking"
  },
  {
    "model_type": "expert",
    "thinking_enabled": false,
    "description": "expert / Pro without thinking"
  },
  {
    "model_type": "expert",
    "thinking_enabled": true,
    "description": "expert / Pro with thinking"
  }
]
```

---

# 20. Search mode

Search is represented by:

```json
{
  "field": "search_enabled",
  "type": "boolean",
  "values": [
    false,
    true
  ]
}
```

The search request still uses:

```text
POST /api/v0/chat/completion
```

There is no separate completion endpoint required for the observed search mode.

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

The fields must be treated separately.

```json
{
  "search_enabled": "request/search capability state",
  "search_triggered": "observed server search state",
  "conversation_mode": "server-reported conversation mode"
}
```

Their exact internal relationship should not be inferred beyond observed behavior.

---

# 22. Combined model/search/thinking state

The protocol represents these as independent request fields:

```json
{
  "model_type": null,
  "thinking_enabled": true,
  "search_enabled": true
}
```

The protocol contract therefore does not define search as a model.

Likewise, it does not define thinking as a separate model.

---

# 23. PoW endpoint

```json
{
  "method": "POST",
  "path": "/api/v0/chat/create_pow_challenge",
  "request_body": {
    "target_path": "/api/v0/chat/completion"
  },
  "response": "PoW challenge object",
  "status": "ESTABLISHED"
}
```

---

# 24. PoW challenge schema

Observed challenge fields:

```json
{
  "algorithm": "string",
  "challenge": "string",
  "salt": "string",
  "signature": "string",
  "difficulty": "number",
  "expire_at": "number|unknown",
  "expire_after": "number|unknown",
  "target_path": "string"
}
```

Observed algorithm:

```json
{
  "algorithm": "DeepSeekHashV1"
}
```

---

# 25. PoW response

The completion request includes:

```text
x-ds-pow-response
```

This header carries the solved PoW result.

The observed architecture is:

```json
{
  "challenge": "server-generated",
  "solution": "client-computed",
  "transport": "x-ds-pow-response"
}
```

---

# 26. PoW binding

The challenge includes:

```json
{
  "target_path": "/api/v0/chat/completion"
}
```

Therefore the PoW challenge is explicitly associated with the completion path.

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

These represent the observed browser protocol.

They should not automatically be interpreted as immutable server requirements.

---

# 28. x-hif-leim

```json
{
  "header": "x-hif-leim",
  "browser_observed": true,
  "semantic_definition": "unknown",
  "wire_role": "undetermined",
  "status": "PROVISIONAL"
}
```

The header belongs to the observed DeepSeek web request contract.

Its semantic purpose is currently not established.

---

# 29. Authentication headers

Authenticated requests carry authentication state.

Conceptually:

```json
{
  "Authorization": "authenticated session",
  "Cookie": "authenticated browser state"
}
```

The exact credential mechanism is separate from the conversation protocol.

Credentials must not be embedded into protocol documentation.

---

# 30. Authentication/session boundary

The protocol distinguishes:

```json
{
  "authentication": {
    "role": "authorization and identity"
  },
  "chat_session_id": {
    "role": "conversation container"
  },
  "parent_message_id": {
    "role": "conversation continuation position"
  }
}
```

These three concepts are independent.

---

# 31. ref_file_ids

Normal observed text completion:

```json
{
  "ref_file_ids": []
}
```

Protocol definition:

```json
{
  "field": "ref_file_ids",
  "type": "array",
  "normal_value": [],
  "attachment_protocol": "not defined by current text-only contract"
}
```

---

# 32. action

Normal observed request:

```json
{
  "action": null
}
```

Protocol status:

```json
{
  "field": "action",
  "normal_value": null,
  "non_null_schema": "UNKNOWN",
  "status": "PROVISIONAL"
}
```

The contract does not define unsupported action values.

---

# 33. preempt

Normal observed request:

```json
{
  "preempt": false
}
```

Protocol status:

```json
{
  "field": "preempt",
  "type": "boolean",
  "observed_normal_value": false,
  "true_semantics": "UNKNOWN"
}
```

---

# 34. Conversation continuation

The canonical continuation state is:

```json
{
  "chat_session_id": "<same-session>",
  "parent_message_id": "<previous response_message_id>"
}
```

A complete sequential conversation therefore has:

```json
[
  {
    "turn": 1,
    "parent_message_id": null,
    "response_message_id": 2
  },
  {
    "turn": 2,
    "parent_message_id": 2,
    "response_message_id": 4
  },
  {
    "turn": 3,
    "parent_message_id": 4,
    "response_message_id": 6
  }
]
```

This is the canonical message-chain behavior represented by the current browser captures.

---

# 35. Model switching

Model switching within an existing session is part of the contract as a provisional capability.

Current status:

```json
{
  "feature": "mid-session model_type switching",
  "ui_observed": false,
  "protocol_status": "PROVISIONAL",
  "headless_request_form": "supported by request schema",
  "semantic_support": "not yet established"
}
```

The request form is:

```json
{
  "chat_session_id": "<existing-session>",
  "parent_message_id": "<latest-response>",
  "model_type": "expert",
  "prompt": "<prompt>",
  "ref_file_ids": [],
  "thinking_enabled": false,
  "search_enabled": false,
  "action": null,
  "preempt": false
}
```

The reverse transition is equally represented:

```json
{
  "chat_session_id": "<existing-session>",
  "parent_message_id": "<latest-response>",
  "model_type": null,
  "prompt": "<prompt>",
  "ref_file_ids": [],
  "thinking_enabled": false,
  "search_enabled": false,
  "action": null,
  "preempt": false
}
```

The protocol distinguishes the existence of the field from proof that the server honors the transition.

---

# 36. Session-scoped versus request-scoped state

The protocol currently establishes:

```json
{
  "chat_session_id": {
    "scope": "session"
  },
  "parent_message_id": {
    "scope": "message chain"
  },
  "model_type": {
    "scope": "request",
    "session_switching": "provisional"
  },
  "thinking_enabled": {
    "scope": "request"
  },
  "search_enabled": {
    "scope": "request"
  }
}
```

Where exact persistence/stickiness is not established, it remains provisional.

---

# 37. Complete normal request

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

# 38. Complete continuation request

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

# 39. Complete expert request

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

# 40. Complete search request

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

# 41. Complete response state

A completed response should yield at minimum:

```json
{
  "request_message_id": 43,
  "response_message_id": 44,
  "model_type": "default"
}
```

The continuation cursor is:

```json
{
  "next_parent_message_id": 44
}
```

---

# 42. Protocol state machine

Machine-readable representation:

```json
{
  "states": [
    "UNAUTHENTICATED",
    "AUTHENTICATED",
    "SESSION_CREATED",
    "COMPLETION_STARTED",
    "READY",
    "STREAMING",
    "COMPLETED",
    "FAILED"
  ],
  "transitions": [
    {
      "from": "AUTHENTICATED",
      "operation": "chat_session/create",
      "to": "SESSION_CREATED"
    },
    {
      "from": "SESSION_CREATED",
      "operation": "create_pow_challenge",
      "to": "SESSION_CREATED"
    },
    {
      "from": "SESSION_CREATED",
      "operation": "chat/completion",
      "to": "COMPLETION_STARTED"
    },
    {
      "from": "COMPLETION_STARTED",
      "event": "ready",
      "to": "READY"
    },
    {
      "from": "READY",
      "event": "content delta",
      "to": "STREAMING"
    },
    {
      "from": "STREAMING",
      "event": "close",
      "to": "COMPLETED"
    }
  ]
}
```

---

# 43. Continuation invariant

```json
{
  "invariant": "NEXT_PARENT_EQUALS_PREVIOUS_RESPONSE",
  "rule": "next.parent_message_id === previous.ready.response_message_id",
  "status": "ESTABLISHED"
}
```

---

# 44. Session invariant

```json
{
  "invariant": "SESSION_STABILITY",
  "rule": "sequential turns in one conversation reuse the same chat_session_id",
  "status": "ESTABLISHED"
}
```

---

# 45. Message identity invariant

```json
{
  "invariant": "READY_IS_AUTHORITATIVE",
  "rule": "ready.response_message_id is the authoritative continuation response ID",
  "status": "ESTABLISHED"
}
```

---

# 46. Model invariant

```json
{
  "invariant": "MODEL_IS_A_REQUEST_DIMENSION",
  "rule": "model_type is transmitted independently of thinking_enabled and search_enabled",
  "status": "ESTABLISHED"
}
```

---

# 47. Search invariant

```json
{
  "invariant": "SEARCH_IS_A_REQUEST_DIMENSION",
  "rule": "search_enabled is transmitted through /api/v0/chat/completion",
  "status": "ESTABLISHED"
}
```

---

# 48. Thinking invariant

```json
{
  "invariant": "THINKING_IS_A_BOOLEAN",
  "rule": "thinking_enabled is represented as a boolean request field",
  "status": "ESTABLISHED"
}
```

---

# 49. Unknown protocol surface

The current contract intentionally leaves the following unspecified:

```json
{
  "unknown": [
    "complete x-hif-leim semantics",
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

Unknown does not mean unsupported.

It means the current contract does not establish the behavior.

---

# 50. Provisional protocol surface

```json
{
  "provisional": [
    {
      "feature": "x-hif-leim",
      "known": "browser sends header",
      "unknown": "semantic/requirement details"
    },
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

# 51. Conformance requirements

An implementation claiming conformance to this contract must preserve the following protocol semantics:

```json
{
  "requirements": [
    "use /api/v0/chat_session/create for session creation",
    "use /api/v0/chat/completion for completion",
    "represent parent_message_id as number|null",
    "use null parent_message_id on the first turn",
    "use the previous response_message_id on subsequent turns",
    "obtain the authoritative new response_message_id from ready",
    "support model_type null/default representation",
    "support model_type expert representation",
    "support thinking_enabled boolean",
    "support search_enabled boolean",
    "include ref_file_ids",
    "represent normal action as null",
    "represent normal preempt as false",
    "perform the required PoW flow",
    "send x-ds-pow-response with the solved challenge",
    "process completion as SSE"
  ]
}
```

---

# 52. Protocol versus implementation

This document defines:

```text
DeepSeek wire protocol
```

It does not define:

```text
application architecture
database architecture
proxy architecture
OpenAI compatibility
client API design
storage implementation
authentication secret management implementation
```

A conforming implementation may use:

```text
Cloudflare Workers
Python
Java
Go
Rust
Node.js
browser JavaScript
```

provided that the wire behavior remains conformant.

The Cloudflare Workers TypeScript section is a reference implementation template, not part of the wire protocol itself.

---

# 53. Cloudflare Workers reference requirements

For a Cloudflare Workers implementation:

```json
{
  "runtime": "Cloudflare Workers",
  "language": "TypeScript",
  "tooling": "Wrangler",
  "node_version_requirement": "none",
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

No Node-specific API is required by the protocol.

---

# 54. Security boundary

Authentication credentials are outside the protocol schema.

The implementation must treat:

```text
Authorization
Cookie
passwords
session tokens
device identifiers
```

as sensitive data.

They must not appear in:

```text
debug logs
protocol examples
source-controlled fixtures
public documentation
machine-readable examples
```

unless explicitly redacted.

---

# 55. Canonical protocol object

For implementations requiring one normalized representation:

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

    "models": {
      "default": null,
      "expert": "expert"
    },

    "modes": {
      "thinking": "thinking_enabled",
      "search": "search_enabled"
    },

    "client_headers": {
      "x-client-bundle-id": "com.deepseek.chat",
      "x-client-platform": "web",
      "x-client-version": "2.4.0",
      "x-client-locale": "en_US",
      "x-client-timezone-offset": "3600",
      "x-hif-leim": "observed; semantics provisional"
    }
  }
}
```

---

# 56. Canonical interpretation

The DeepSeek Web protocol currently consists of four principal request dimensions:

```text
conversation
    chat_session_id
    parent_message_id

model
    model_type

reasoning
    thinking_enabled

search
    search_enabled
```

along with common completion properties:

```text
prompt
ref_file_ids
action
preempt
```

and transport/security requirements:

```text
authentication
client headers
PoW
SSE
```

The protocol therefore should be implemented as a collection of explicit typed fields and state transitions rather than as a collection of UI-specific model names.

---

# 57. Contract status

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
  "x_hif_leim": "PROVISIONAL",
  "mid_session_model_switch": "PROVISIONAL",
  "non_null_action": "UNKNOWN",
  "preempt_true": "UNKNOWN",
  "file_protocol": "UNKNOWN"
}
```

---

# 58. Normative rule

The final rule governing this specification is:

```text
A browser-observed value defines what the browser sends.

A validated server behavior defines what the protocol accepts.

An inferred behavior must remain marked as inferred.

An unestablished behavior must remain unknown or provisional.

No implementation assumption becomes a DeepSeek protocol rule merely because an implementation chooses to use it.
```

This document therefore represents the **DeepSeek Web protocol contract**, with Cloudflare Workers TypeScript serving only as the reference implementation form.