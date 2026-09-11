# DeepSeek Web Completion SSE Client Translation Guide

## Version
```text
contract_version = "1.1"
extends = "DeepSeek_Web_Endpoint_Contract.md (v2.3)"
protocol_target = "DeepSeek Web Chat Completion SSE Stream Translation"
evidence_basis = "V4-pro-plus-login.har, dev-browser-20260910-001517.har, extensive_usage_network_test.har"
```

---

## 1. Protocol Overview: Request to SSE Mapping
This guide defines the exact mechanical translation between the `POST /api/v0/chat/completion` request payload and the resulting Server-Sent Events (SSE) stream. It is designed for client developers building proxies, SDKs, or headless integrations.

| Request Field | SSE Response Correlation | Normative Rule |
|---|---|---|
| `thinking_enabled: true` | First fragment `type` is `"THINK"` | The model will stream a reasoning trace before the final response. |
| `thinking_enabled: false` | First fragment `type` is `"RESPONSE"` | The model streams the final response directly. |
| `model_type: "expert"` (or `null`) | `ready` event `model_type` | The `ready` event provides the **authoritative** server-resolved model path. |
| `parent_message_id: null` | `ready` event `request_message_id: 1` | First turn in a session. |
| `parent_message_id: <N>` | `ready` event `request_message_id: <N+2>` | Subsequent turns. The next request must use the previous `response_message_id`. |

---

## 2. SSE Event Lifecycle Sequence
A successful completion stream follows a strict, observed sequence of events. Clients must be prepared to handle this exact order:

1. **`event: ready`**  
   `data: {"request_message_id": 3, "response_message_id": 4, "model_type": "expert"}`  
   *Authoritative source for message IDs and server-resolved model.*
2. **`event: update_session`**  
   `data: {"updated_at": 1789000205.864529}`  
   *Session metadata update.*
3. **`data:` (Initial State Payload)**  
   `data: {"v": {"response": { ... "fragments": [...] }}}`  
   *Establishes the baseline state object. Note: This is a default `message` event (no explicit `event:` prefix).*
4. **`data:` (Delta Patches)**  
   `data: {"p": "...", "o": "APPEND", "v": "..."}` or `data: {"v": "..."}`  
   *Streaming content updates. Repeated dozens/hundreds of times.*
5. **`data:` (Terminal Status)**  
   `data: {"p": "response/status", "o": "SET", "v": "FINISHED"}`  
   *Signals the end of content generation.*
6. **`event: update_session`** (Optional)  
   Final session metadata update.
7. **`event: title`** (Optional)  
   `data: {"content": "Generated Chat Title"}`  
   *Asynchronous title generation payload.*
8. **`event: close`**  
   `data: {"click_behavior": "none", "auto_resume": false}`  
   *Stream termination signal.*

---

## 3. The Delta Patch Protocol (Critical)
To minimize bandwidth, the SSE stream does **not** send the full JSON state on every chunk. It uses a JSON Patch-like delta protocol. 

### 3.1 Standard Patch Schema
```json
{
  "p": "response/fragments/-1/content",
  "o": "APPEND",
  "v": " text chunk"
}
```
- **`p` (Path)**: A slash-separated path. The index `-1` **always** refers to the last element in the `fragments` array.
- **`o` (Operation)**: `"APPEND"` (concatenate/push) or `"SET"` (replace).
- **`v` (Value)**: The payload to apply (string, number, or object).

### 3.2 Stream Compression Shorthand (⚠️ Critical Parsing Rule)
HAR analysis reveals that after an initial explicit patch, the server often omits `p` and `o` to save bytes:
```json
{ "p": "response/fragments/-1/content", "o": "APPEND", "v": " need" }
{ "v": " answer" }
{ "v": "." }
```
**Normative Parsing Rule**: If a `data:` payload contains **only** a `v` key (or is missing `p`/`o`), the client **MUST** default to:
- `p = "response/fragments/-1/content"`
- `o = "APPEND"`

---

## 4. Fragment Types: Extracting Reasoning vs. Response
The `fragments` array is the core of the response. Each fragment has a strict `type`:

| Fragment `type` | Meaning | Extraction Target |
|---|---|---|
| `"THINK"` | Chain-of-thought / Reasoning trace | Accumulate into `reasoning` string. |
| `"RESPONSE"` | Final user-facing answer | Accumulate into `content` string. |

*Note*: A single completion may contain multiple fragments. The standard pattern is one `"THINK"` fragment followed by one `"RESPONSE"` fragment. When a new fragment is appended via `{"p": "response/fragments", "o": "APPEND", "v": {...}}`, the `-1` index automatically shifts to this new fragment.

---

## 5. Production-Ready TypeScript Implementation
A robust, type-safe parser that consumes a `ReadableStream`, maintains the delta state, handles the shorthand compression, and cleanly separates reasoning from content.

```typescript
/**
 * DeepSeek Web Completion SSE Parser
 * Translates raw SSE delta streams into structured LLM responses.
 */

export interface DeepSeekFragment {
  id: number;
  type: 'THINK' | 'RESPONSE';
  content: string;
  elapsed_secs?: number;
  references: any[];
  stage_id: number;
}

export interface DeepSeekResponseState {
  message_id: number;
  parent_id: number;
  model: string;
  role: string;
  thinking_enabled: boolean;
  status: 'WIP' | 'FINISHED';
  fragments: DeepSeekFragment[];
}

export interface ParsedCompletionResult {
  status: 'WIP' | 'FINISHED' | 'UNKNOWN';
  reasoning: string;
  content: string;
  messageId: number | null;
  responseMessageId: number | null;
  modelType: string | null;
}

export class DeepSeekSSEParser {
  private state: DeepSeekResponseState | null = null;
  private reasoningChunks: string[] = [];
  private contentChunks: string[] = [];
  
  // Metadata from the 'ready' event
  public requestMessageId: number | null = null;
  public responseMessageId: number | null = null;
  public resolvedModelType: string | null = null;

  /**
   * Process a single line from the SSE stream.
   * Call this for every line yielded by a TextDecoder stream.
   */
  public parseLine(line: string): ParsedCompletionResult | null {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith(':')) return null; // Ignore comments/empty

    // 1. Handle explicit event types
    if (trimmed.startsWith('event: ready')) {
      // The next line will be the data payload for 'ready'
      // Handled in the 'data:' block below by checking context, 
      // but for simplicity, we assume standard Fetch API EventSource parsing 
      // where 'event' and 'data' are processed together. 
      // If parsing raw text, you must buffer the event type.
      return null; 
    }

    if (!trimmed.startsWith('data:')) return null;

    const jsonStr = trimmed.slice(5).trim();
    if (!jsonStr) return null;

    try {
      const payload = JSON.parse(jsonStr);

      // 2. Ready Event Payload (often lacks 'event:' prefix in raw text, identified by keys)
      if (payload.request_message_id !== undefined && payload.response_message_id !== undefined) {
        this.requestMessageId = payload.request_message_id;
        this.responseMessageId = payload.response_message_id;
        this.resolvedModelType = payload.model_type || null;
        return this.getCurrentResult();
      }

      // 3. Initial State Payload
      if (payload.v?.response) {
        this.state = payload.v.response;
        this.rebuildAccumulatedContent();
        return this.getCurrentResult();
      }

      // 4. Delta Patch Payload
      if (payload.v !== undefined) {
        const path = payload.p || 'response/fragments/-1/content'; // Shorthand default
        const op = payload.o || 'APPEND';                          // Shorthand default
        this.applyPatch(path, op, payload.v);
      }

      return this.getCurrentResult();
    } catch (e) {
      console.warn('[DeepSeekSSEParser] Failed to parse SSE line:', jsonStr);
      return null;
    }
  }

  private applyPatch(path: string, op: string, value: any) {
    if (!this.state) return;

    if (path === 'response/fragments/-1/content') {
      const lastFragment = this.state.fragments[this.state.fragments.length - 1];
      if (lastFragment) {
        if (op === 'APPEND') {
          lastFragment.content += value;
        } else if (op === 'SET') {
          lastFragment.content = value;
        }
        this.updateAccumulatedContent(lastFragment);
      }
    } 
    else if (path === 'response/fragments' && op === 'APPEND') {
      const newFragments = Array.isArray(value) ? value : [value];
      this.state.fragments.push(...newFragments);
      for (const frag of newFragments) {
        this.updateAccumulatedContent(frag);
      }
    }
    else if (path === 'response/fragments/-1/elapsed_secs') {
      const lastFragment = this.state.fragments[this.state.fragments.length - 1];
      if (lastFragment) lastFragment.elapsed_secs = value;
    }
    else if (path === 'response/status') {
      this.state.status = value;
    }
  }

  private updateAccumulatedContent(fragment: DeepSeekFragment) {
    // We rebuild from the fragment's current content to handle SET operations correctly
    if (fragment.type === 'THINK') {
      // Find and replace the last chunk for this fragment to handle SET, or just push for APPEND
      // For simplicity in streaming, we track by fragment ID or just rebuild entirely
      this.rebuildAccumulatedContent();
    } else if (fragment.type === 'RESPONSE') {
      this.rebuildAccumulatedContent();
    }
  }

  private rebuildAccumulatedContent() {
    this.reasoningChunks = [];
    this.contentChunks = [];
    if (!this.state) return;

    for (const frag of this.state.fragments) {
      if (frag.type === 'THINK') {
        this.reasoningChunks.push(frag.content);
      } else if (frag.type === 'RESPONSE') {
        this.contentChunks.push(frag.content);
      }
    }
  }

  public getCurrentResult(): ParsedCompletionResult {
    return {
      status: this.state?.status || 'UNKNOWN',
      reasoning: this.reasoningChunks.join(''),
      content: this.contentChunks.join(''),
      messageId: this.state?.message_id || null,
      responseMessageId: this.responseMessageId,
      modelType: this.resolvedModelType
    };
  }
}
```

---

## 6. Usage Example: Fetch API Integration
How to wire the parser into a standard web or Node.js `fetch` call.

```typescript
async function streamCompletion(prompt: string, sessionId: string, parentMessageId: number | null) {
  const response = await fetch('https://chat.deepseek.com/api/v0/chat/completion', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'text/event-stream',
      'x-ds-pow-response': '<solved-pow>',
      'x-hif-leim': '<opaque-hif-leim>',
      // ... other required client headers
    },
    body: JSON.stringify({
      chat_session_id: sessionId,
      parent_message_id: parentMessageId,
      model_type: null, // or "expert"
      prompt: prompt,
      thinking_enabled: true,
      search_enabled: false,
      ref_file_ids: [],
      action: null,
      preempt: false
    })
  });

  if (!response.body) throw new Error('No response body');

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const parser = new DeepSeekSSEParser();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    
    // Keep the last partial line in the buffer for the next iteration
    buffer = lines.pop() || '';

    for (const line of lines) {
      const result = parser.parseLine(line);
      if (result) {
        // Yield or process the incremental result
        console.log('Reasoning:', result.reasoning);
        console.log('Content:', result.content);
        
        if (result.status === 'FINISHED') {
          console.log('Stream complete. Next parent_message_id should be:', result.responseMessageId);
          return result;
        }
      }
    }
  }
  
  return parser.getCurrentResult();
}
```

---

## 7. Edge Cases & Conformance Checklist
A conforming SSE client implementation **MUST**:

- [ ] **Handle Shorthand Deltas**: Default to `p="response/fragments/-1/content"` and `o="APPEND"` when a `data:` payload contains only `{"v": "..."}`.
- [ ] **Track Fragment Types**: Never assume all content is "response". Explicitly check `fragment.type === 'THINK'` to route to the reasoning buffer.
- [ ] **Use `ready` for Continuation**: The `response_message_id` from the `ready` event is the **only** valid `parent_message_id` for the next request in the conversation.
- [ ] **Rebuild on State Replacement**: If an `o: "SET"` operation occurs (rare, but observed for metadata like `elapsed_secs`), ensure the accumulated string is rebuilt from the `state.fragments` array, not just blindly appended.
- [ ] **Graceful Degradation**: If the stream closes abruptly without a `"FINISHED"` status, the client should still return the accumulated `reasoning` and `content` chunks up to that point, marked with `status: "WIP"`.

--- 

*This document serves as the definitive translation layer between the DeepSeek Web wire protocol and standard LLM client abstractions. Save as `Completion_SSE_Client_Translation_Guide.md`.*
