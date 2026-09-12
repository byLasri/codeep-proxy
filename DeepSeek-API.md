# DeepSeek API Architecture

## Chat Sessions Management

### Public Endpoint: `/deepseekprotocol`

**Purpose**: Development/debug endpoint to call the `deepseek_api` module directly, bypassing the translator layer.

**Method**: `POST`

**Request Body** (DeepSeekCompletionInput):

```json
{
  "session": {
    "chat_session_id": "string (OPTIONAL - if omitted, session auto-created)",
    "parent_message_id": "number (REQUIRED if session provided - no default)"
  },
  "prompt": "string (REQUIRED)",
  "model_type": "string|null (REQUIRED: null | 'expert' | 'default')",
  "thinking_enabled": "boolean (OPTIONAL - default: false)",
  "search_enabled": "boolean (OPTIONAL - default: false)",
  "ref_file_ids": "string[] (OPTIONAL - default: [])",
  "action": "null (FIXED - must be null, cannot be overridden)",
  "preempt": "false (FIXED - must be false, cannot be overridden)"
}
```

**Validation Rules** (per `src/index.ts:487-503`):
- `prompt` — **REQUIRED**, must be string
- `model_type` — **REQUIRED**, must not be `undefined` (accepts `null`, `"expert"`, `"default"`, or string)
- `session` — **OPTIONAL** (if omitted, `deepseek_api` auto-creates via `createSession()`)
- `session.chat_session_id` — **REQUIRED if session provided**, must be string
- `session.parent_message_id` — **REQUIRED if session provided**, must be number (no default, no null allowed)
- `action` — **FIXED to `null`** (line 525), ignored if provided in request
- `preempt` — **FIXED to `false`** (line 526), ignored if provided in request
- All other fields — Optional, worker applies defaults (see below)

**Worker Defaults** (applied in `src/index.ts:530-534`):
| Field | Default |
|-------|---------|
| `thinking_enabled` | `false` |
| `search_enabled` | `false` |
| `ref_file_ids` | `[]` |
| `action` | `null` (FIXED) |
| `preempt` | `false` (FIXED) |

**Response**: Raw DeepSeek SSE stream (`text/event-stream`)

**Behavior**:
- If `session` omitted entirely → `deepseek_api.completeWithAutoSession()` creates new session via `POST /api/v0/chat_session/create` (with `parent_message_id: null` for first turn)
- If `session` provided → **BOTH** `chat_session_id` AND `parent_message_id` must be present (validated at worker level)
- `action` and `preempt` are **protocol constants** — always sent as `null` and `false` to external `/completions` endpoint
- Returns raw DeepSeek wire protocol SSE events (`ready`, `data`, `update_session`, `title`, `close`)

---

### Strict Protocol Constants & Validation Rules

The following rules are **enforced by the worker** (`src/index.ts:494-535`) and **must be complied with** by all callers:

#### Fixed Protocol Constants (Cannot Be Overridden)
These values are **hardcoded** in the worker and **always sent to the external DeepSeek `/completions` endpoint**. Any values provided in the request for these fields are **ignored**.

| Field | Fixed Value | Source | Reason |
|-------|-------------|--------|--------|
| `action` | `null` | Worker line 525 (`const fixedAction = null`) | Observed as `null` in all HAR captures; server-side purpose unknown |
| `preempt` | `false` | Worker line 526 (`const fixedPreempt = false`) | Observed as `false` in all HAR captures; server-side purpose unknown |

> **Why fixed?** We do not know what these parameters do server-side. All captured HAR traffic shows them as constant values. Until we investigate and discover their purpose, they MUST remain fixed to avoid unexpected server behavior.

#### Session Validation Rules
When `session` object is provided in the request, **BOTH** fields are **REQUIRED**:

| Field | Required? | Validation |
|-------|-----------|------------|
| `session.chat_session_id` | ✅ YES | Must be non-empty string |
| `session.parent_message_id` | ✅ YES | Must be a number (NOT null, NOT undefined) |

**Error responses:**
- Missing `chat_session_id`: `"Invalid request: session.chat_session_id is required"` (400)
- Missing `parent_message_id`: `"Invalid request: session.parent_message_id is required when session is provided"` (400)

#### Auto-Session Creation (When `session` Omitted)
If `session` is **not provided** in the request:
1. Worker calls `deepseek_api.completeWithAutoSession()`
2. `deepseek_api` calls `POST /api/v0/chat_session/create` internally
3. New session created with `parent_message_id: null` (first turn)
4. Completion proceeds with new session

#### Complete Request Sent to External `/completions` Endpoint
The `deepseek_api` module **always sends all fields** to `https://chat.deepseek.com/api/v0/chat/completion`:

```json
{
  "chat_session_id": "string",
  "parent_message_id": "number|null",
  "model_type": "null|string",
  "prompt": "string",
  "ref_file_ids": "string[]",
  "thinking_enabled": "boolean",
  "search_enabled": "boolean",
  "action": null,      // FIXED - always null
  "preempt": false     // FIXED - always false
}
```

**Source**: `src/deepseek_api/completion.ts:22-32` - `buildCompletionRequest()` passes all fields through.

---

### Session Management & D1 Storage (Worker Level)

The worker (`src/index.ts`) manages session lifecycle with Cloudflare D1:

#### Session Creation & Storage Flow
```
1. POST /deepseekprotocol (no session)
       ↓
2. Worker calls deepseek_api.createSession() → POST /api/v0/chat_session/create
       ↓
3. Worker creates session record in D1 with parent_message_id: 0
       ↓
4. Worker calls deepseek_api.complete() with new session (parent_message_id: null)
       ↓
5. On SUCCESS: Worker parses SSE stream, extracts response_message_id
       ↓
6. Worker upserts session in D1 with new response_message_id
       ↓
7. Returns raw SSE stream to client
```

#### Session Validation & Continuation Flow
```
1. POST /deepseekprotocol (with session.chat_session_id + parent_message_id)
       ↓
2. Worker validates BOTH fields present (400 if missing)
       ↓
3. Worker reads D1 table `sessions` for chat_session_id
       ↓
4. If no session in D1 → 404 "session not found in store"
       ↓
5. Uses STORED parent_message_id (ignores provided value)
       ↓
6. Calls deepseek_api.complete() with validated session
       ↓
7. On SUCCESS: Updates D1 with new response_message_id
```

#### D1 Database Schema
**Table**: `sessions` (TTL managed by worker: 259200s / 3 days)

```sql
CREATE TABLE sessions (
  chat_session_id TEXT PRIMARY KEY,
  parent_message_id INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
```

**Row Example**:
```json
{
  "chat_session_id": "uuid-from-create",
  "parent_message_id": 8,
  "created_at": 1789188539451,
  "updated_at": 1789190351061
}
```

#### Key Behaviors
| Scenario | Behavior |
|----------|----------|
| No session provided | Auto-create via `/api/v0/chat_session/create`, use `parent_message_id: null`, create D1 record |
| Session provided, not in D1 | 404 error |
| Session provided, ID mismatch | 404 error (not possible with PK constraint) |
| Session provided, wrong parent_message_id | Uses stored value, ignores provided |
| Completion fails (non-200) | Session NOT updated |
| Completion succeeds | Session updated with `response_message_id` from `ready` event |
| Multiple concurrent sessions | Each tracked independently by `chat_session_id` PK |

#### D1 Functions (in `src/index.ts`)
| Function | Purpose |
|----------|---------|
| `initSessionsTable(db)` | Creates `sessions` table if not exists |
| `getSession(db, chat_session_id)` | Retrieves session by ID |
| `upsertSession(db, chat_session_id, parent_message_id)` | Creates or updates session |
| `createSessionRecord(db, chat_session_id)` | Initial record with `parent_message_id: 0` |

---

### Internal DeepSeek Wire Endpoints (Called by `deepseek_api` Module)

The `deepseek_api` module internally calls these **external DeepSeek web endpoints**. They are **NOT exposed** by the `deepseek_api` module — they are implementation details called on behalf of the client.

| Endpoint | Purpose | Called By |
|----------|---------|-----------|
| `POST https://chat.deepseek.com/api/v0/chat_session/create` | Creates new chat session, returns `chat_session_id` | `deepseek_api` → `createSession()` |
| `POST https://chat.deepseek.com/api/v0/chat/create_pow_challenge` | Creates Proof-of-Work challenge for completion | `deepseek_api` → `createPowChallenge()` |
| `GET https://hif-leim.deepseek.com/query` | Acquires HIF-LEIM token (cached 600s) | `deepseek_api` → `HifLeimCache.getValue()` |
| `POST https://chat.deepseek.com/api/v0/chat/completion` | Main completion endpoint (SSE stream) | `deepseek_api` → `complete()` |

**Architecture**:
```
Client → /deepseekprotocol (Worker)
          ↓
    deepseek_api.DeepSeekWebClient.completeWithAutoSession()
          ↓
    ┌─────────────────────────────────────┐
    │ Internal calls (NOT exposed):       │
    │ 1. POST /api/v0/chat_session/create │ ← Auto if no session_id
    │ 2. GET https://hif-leim.deepseek.com/query
    │ 3. POST /api/v0/chat/create_pow_challenge
    │ 4. POST /api/v0/chat/completion     │
    └─────────────────────────────────────┘
          ↓
    Returns raw SSE to client
```

---

### Future: `/completions` Endpoint (Under Construction)

**Status**: Under construction

**Roadmap**: Will become the **production endpoint** exposed by a future module called **`deepseek_translator`**.

**Purpose**: 
- Translate OpenAI-compatible requests (`/v1/chat/completions`) → DeepSeek wire protocol
- Handle session management, conversation continuation, model mapping
- Expose clean OpenAI API surface to consumers

**Relationship to `/deepseekprotocol`**:
- `/deepseekprotocol` is for **dev purposes only** — direct access to `deepseek_api` for debugging
- When `deepseek_translator` is implemented, it will **own** the completion flow
- `/deepseekprotocol` will be **called internally by `deepseek_translator`** or **removed** (since it becomes `deepseek_translator`'s property)
- `deepseek_translator` will expose `POST /v1/chat/completions` as the public production API

---

### Summary: What Is Exposed vs Internal

| Layer | Endpoint | Exposed By | Status |
|-------|----------|------------|--------|
| **Worker (Current)** | `POST /deepseekprotocol` | Worker (`src/index.ts`) | Dev/Debug — Direct `deepseek_api` access |
| **Worker (Current)** | `GET /v1/debug/hif-cache` | Worker | Debug only |
| **deepseek_api (Internal)** | `POST /api/v0/chat_session/create` | **NOT EXPOSED** | Called internally by `createSession()` |
| **deepseek_api (Internal)** | `POST /api/v0/chat/completion` | **NOT EXPOSED** | Called internally by `complete()` |
| **deepseek_api (Internal)** | `GET /query (hif-leim)` | **NOT EXPOSED** | Called internally by `HifLeimCache` |
| **Future Module** | `POST /v1/chat/completions` | `deepseek_translator` | **Planned** — Production OpenAI-compatible API |

---

### Session Lifetime

- DeepSeek session TTL: **259,200 seconds (3 days)** per wire contract
- `chat_session_id` returned by `/api/v0/chat_session/create`
- Conversation continuation: Use `ready.response_message_id` as next `parent_message_id`
- HIF-LEIM token TTL: **600 seconds** (cached in KV, auto-refreshed)

---

### Model Types (Wire Protocol)

| Wire Value | Product Path |
|------------|--------------|
| `null` | Default / Instant (Flash V4.1) |
| `"expert"` | Expert / Pro (Pro V4) |

> Note: `"default"` is a **settings/session identifier only** — not a valid completion request value per wire contract.

---

## Appendix: Complete Wire Request/Response Bodies (from HAR Captures)

### 1. Chat Session Creation

**Endpoint**: `POST https://chat.deepseek.com/api/v0/chat_session/create`

#### Request
```json
{}
```

#### Response
```json
{
  "code": 0,
  "msg": "",
  "data": {
    "biz_code": 0,
    "biz_msg": "",
    "biz_data": {
      "chat_session": {
        "id": "5e026bd1-2125-4da6-943a-aeca05b9a1a2",
        "seq_id": 211344909,
        "agent": "chat",
        "model_type": "default",
        "title": null,
        "title_type": "WIP",
        "version": 0,
        "current_message_id": null,
        "pinned": false,
        "inserted_at": 1789181709.828,
        "updated_at": 1789181709.828
      },
      "ttl_seconds": 259200
    }
  }
}
```

**Key Fields**:
- `data.biz_data.chat_session.id` → `chat_session_id` (used in completion requests)
- `data.biz_data.ttl_seconds` → 259200 (3 days)

---

### 2. Proof-of-Work Challenge

**Endpoint**: `POST https://chat.deepseek.com/api/v0/chat/create_pow_challenge`

#### Request
```json
{
  "target_path": "/api/v0/chat/completion"
}
```

#### Response
```json
{
  "code": 0,
  "msg": "",
  "data": {
    "biz_code": 0,
    "biz_msg": "",
    "biz_data": {
      "challenge": {
        "algorithm": "DeepSeekHashV1",
        "challenge": "d9615b470621bf7c6c56aa1b09e3546cfd7251fb53b0180278b485e7086c6064",
        "salt": "da5b4a12d78d4a2cfc69",
        "signature": "f55c86f22df650b3961e5c84ca40c0c6fa1b3e5df30c40c9ceb8178ae9229b97",
        "difficulty": 144000,
        "expire_at": 1789182009820,
        "expire_after": 300000,
        "target_path": "/api/v0/chat/completion"
      }
    }
  }
}
```

**Key Fields**:
- `data.biz_data.challenge.challenge` → The challenge string to solve
- `data.biz_data.challenge.salt` → Salt for PoW
- `data.biz_data.challenge.difficulty` → 144000 (current)
- `data.biz_data.challenge.expire_after` → 300000ms (5 min)

---

### 3. HIF-LEIM Acquisition

**Endpoint**: `GET https://hif-leim.deepseek.com/query`

#### Request Headers
```
accept: */*
x-client-bundle-id: com.deepseek.chat
x-client-platform: web
x-client-version: 2.4.0
x-client-locale: en_US
x-client-timezone-offset: 3600
```
> Note: No `Authorization`, `Cookie`, `Origin`, or `Referer` headers

#### Response
```json
{
  "code": 0,
  "msg": "",
  "data": {
    "biz_code": 0,
    "biz_msg": "",
    "biz_data": {
      "value": "<opaque-hif-leim-value>"
    }
  }
}
```

**Extraction**: `data.biz_data.value` → opaque string → inject as `x-hif-leim` header

---

### 4. Completion Request (First Turn)

**Endpoint**: `POST https://chat.deepseek.com/api/v0/chat/completion`

#### Request (First Turn - New Session)
```json
{
  "chat_session_id": "38f4d8da-89de-4c3c-9b85-c364dac055d4",
  "parent_message_id": null,
  "model_type": "default",
  "prompt": "First message hello!",
  "ref_file_ids": [],
  "thinking_enabled": false,
  "search_enabled": false,
  "action": null,      // FIXED - protocol constant
  "preempt": false     // FIXED - protocol constant
}
```

> Note: First turn uses `parent_message_id: null` and `model_type: "default"` (settings value). Wire protocol values for model_type are `null` or `"expert"`.

#### Request (Continuation Turn)
```json
{
  "chat_session_id": "38f4d8da-89de-4c3c-9b85-c364dac055d4",
  "parent_message_id": 2,
  "model_type": null,
  "prompt": "Second message how are you ?",
  "ref_file_ids": [],
  "thinking_enabled": false,
  "search_enabled": false,
  "action": null,      // FIXED - protocol constant
  "preempt": false     // FIXED - protocol constant
}
```

> Note: Continuation uses previous `ready.response_message_id` as `parent_message_id`. Wire protocol uses `null` for default model.

#### Request (With Thinking Enabled)
```json
{
  "chat_session_id": "ca744773-9eba-4f17-998e-a4f935542e62",
  "parent_message_id": 10,
  "model_type": null,
  "prompt": "deepthink on midsession say I think",
  "ref_file_ids": [],
  "thinking_enabled": true,
  "search_enabled": false,
  "action": null,
  "preempt": false
}
```

#### Request (With File References)
```json
{
  "chat_session_id": "024a0665-6ae6-4f1b-8082-e402b8d61954",
  "parent_message_id": null,
  "model_type": "default",
  "prompt": "",
  "ref_file_ids": [
    "file-92d7ed9a-9f03-4049-b40a-f1841bb90566"
  ],
  "thinking_enabled": true,
  "search_enabled": false,
  "action": null,
  "preempt": false
}
```

---

### 5. Completion Response (SSE Stream)

The completion endpoint returns a Server-Sent Events (SSE) stream with the following event types:

#### Event: `ready`
```json
event: ready
data: {"request_message_id":1,"response_message_id":2,"model_type":"default"}
```
- `request_message_id` → Client's message sequence
- `response_message_id` → **Use as next `parent_message_id`**
- `model_type` → Server-resolved model path ("default" or "expert")

#### Event: `update_session`
```json
event: update_session
data: {"updated_at":1789181711.2138479}
```

#### Event: `data` (Content Fragments)
```json
data: {"v":{"response":{"message_id":2,"parent_id":1,"model":"","role":"ASSISTANT","thinking_enabled":false,"ban_edit":false,"ban_regenerate":false,"status":"WIP","incomplete_message":null,"accumulated_token_usage":0,"feedback":null,"inserted_at":1789181711.200752,"search_enabled":false,"fragments":[{"id":2,"type":"RESPONSE","content":"Hello","references":[],"stage_id":1}],"conversation_mode":"DEFAULT","has_pending_fragment":false,"auto_continue":false,"search_triggered":false}}}
```

**Content Delta (APPEND patches)**:
```json
data: {"p":"response/fragments/-1/content","o":"APPEND","v":"!"}
data: {"v":" How"}
data: {"v":" can"}
data: {"v":" I"}
data: {"v":" help"}
data: {"v":" you"}
data: {"v":" today"}
data: {"v":"?"}
```

**Finish Signal**:
```json
data: {"p":"response","o":"BATCH","v":[{"p":"accumulated_token_usage","v":49},{"p":"quasi_status":"FINISHED"}]}
data: {"p":"response/status","o":"SET","v":"FINISHED"}
```

#### Event: `title`
```json
event: title
data: {"content":"Auto session test"}
```

#### Event: `close`
```json
event: close
data: {"click_behavior":"none","auto_resume":false}
```

---

### 6. Completion Request with Tools/Actions

**Request** (with function definitions in prompt):
```json
{
  "chat_session_id": "971098d9-8eac-4506-8062-b35266b2b930",
  "parent_message_id": null,
  "model_type": "default",
  "prompt": "[\n  {\n    \"type\": \"function\",\n    \"function\": {\n      \"name\": \"list_dir\",\n      \"description\": \"List the entries in a directory...\",\n      \"parameters\": {\n        \"type\": \"object\",\n        \"properties\": {\n          \"path\": {\n            \"type\": \"string\",\n            \"description\": \"Path of the directory to list.\"\n          }\n        },\n        \"required\": [\"path\"],\n        \"additionalProperties\": false\n      }\n    }\n  },\n  ...\n]\n\nlist cur dir",
  "ref_file_ids": [
    "file-4bea8e6c-ea45-4c3b-bc80-67ccfd7c9f03"
  ],
  "thinking_enabled": true,
  "search_enabled": false,
  "action": null,
  "preempt": false
}
```

---

### Summary: Complete Flow

```
1. POST /api/v0/chat_session/create
   → Returns: chat_session_id, ttl_seconds=259200

2. GET https://hif-leim.deepseek.com/query (cached 600s)
   → Returns: data.biz_data.value → x-hif-leim header

3. POST /api/v0/chat/create_pow_challenge
   → Body: {"target_path": "/api/v0/chat/completion"}
   → Returns: challenge, salt, difficulty=144000, expire_after=300000

4. Solve PoW (DeepSeekHashV1) → x-ds-pow-response header

5. POST /api/v0/chat/completion
   → Headers: x-hif-leim, x-ds-pow-response, client identity headers
   → Body: {
       chat_session_id: string,
       parent_message_id: number|null,
       model_type: null|"expert"|"default"|string,
       prompt: string,
       ref_file_ids: string[],
       thinking_enabled: boolean,
       search_enabled: boolean,
       action: null,      // FIXED - protocol constant
       preempt: false     // FIXED - protocol constant
     }
   → Returns: SSE stream (ready → data* → update_session → title → close)

6. Next turn: Use ready.response_message_id as parent_message_id
```

**Critical Protocol Constants** (always sent to external `/completions`):
- `action: null` — Fixed, never varies (server-side purpose unknown, observed as null in all HAR captures)
- `preempt: false` — Fixed, never varies (server-side purpose unknown, observed as false in all HAR captures)
- These are **not configurable** — worker enforces them, deepseek_api passes them through