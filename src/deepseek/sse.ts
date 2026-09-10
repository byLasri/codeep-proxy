// DeepSeek Web Protocol SSE Parser
// Parses DeepSeek SSE stream into structured result

import type {
  DeepSeekCompletionResult,
  DeepSeekSSEEvent,
  DeepSeekReadyEvent,
  DeepSeekDelta,
} from "./types.js";
import { DeepSeekProtocolError } from "./errors.js";

interface DeltaEvent {
  p?: string;
  o?: "SET" | "APPEND" | "BATCH";
  v?: unknown;
}

function isReadyEvent(event: unknown): event is DeepSeekReadyEvent {
  return (
    typeof event === "object" &&
    event !== null &&
    "request_message_id" in event &&
    "response_message_id" in event &&
    "model_type" in event
  );
}

function isDeltaEvent(event: unknown): event is DeltaEvent {
  return typeof event === "object" && event !== null && ("p" in event || "o" in event || "v" in event);
}

export async function parseCompletionStream(response: Response): Promise<DeepSeekCompletionResult> {
  if (!response.body) {
    throw new DeepSeekProtocolError(
      "DeepSeek completion response has no body",
      { kind: "sse" }
    );
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();

  const events: DeepSeekSSEEvent[] = [];
  let requestMessageId: number | null = null;
  let responseMessageId: number | null = null;
  let modelType: string | null = null;
  let outputText = "";
  let searchEnabled = false;
  let searchTriggered = false;
  let conversationMode: string | undefined;

  let pending = "";
  let readyReceived = false;

  const deltaParser = createDeltaParser((text) => {
    outputText += text;
  });

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    pending += decoder.decode(value, { stream: true });
    const lines = pending.split(/\r?\n/);
    pending = lines.pop() ?? "";

    for (const line of lines) {
      const trimmed = line.trim();

      if (trimmed === "event: close") {
        const closeEvent: DeepSeekSSEEvent = { event: "close" };
        events.push(closeEvent);
        continue;
      }

      if (trimmed.startsWith("event:")) {
        const eventName = trimmed.slice(6).trim();
        // Store event type for next data line
        continue;
      }

      if (trimmed.startsWith("data:")) {
        const dataStr = trimmed.slice(5).trim();
        if (dataStr === "") continue;

        try {
          const data = JSON.parse(dataStr);
          const event: DeepSeekSSEEvent = { data };
          events.push(event);

          // Handle ready event
          if (isReadyEvent(data)) {
            readyReceived = true;
            requestMessageId = data.request_message_id;
            responseMessageId = data.response_message_id;
            modelType = data.model_type;

            // Map "default" from server to null for wire consistency
            if (modelType === "default") {
              modelType = null;
            }
          }

          // Handle delta events
          if (isDeltaEvent(data)) {
            deltaParser(data);
          }

          // Handle search-related fields from update_session or other events
          if (typeof data === "object" && data !== null) {
            if ("search_enabled" in data && typeof data.search_enabled === "boolean") {
              searchEnabled = data.search_enabled;
            }
            if ("search_triggered" in data && typeof data.search_triggered === "boolean") {
              searchTriggered = data.search_triggered;
            }
            if ("conversation_mode" in data && typeof data.conversation_mode === "string") {
              conversationMode = data.conversation_mode;
            }
          }
        } catch {
          // Ignore parse errors for malformed data lines
        }
      }
    }
  }

  // Process any remaining pending data
  if (pending.trim().startsWith("data:")) {
    try {
      const data = JSON.parse(pending.slice(5).trim());
      if (isReadyEvent(data)) {
        readyReceived = true;
        requestMessageId = data.request_message_id;
        responseMessageId = data.response_message_id;
        modelType = data.model_type;
        if (modelType === "default") modelType = null;
      }
      if (isDeltaEvent(data)) {
        deltaParser(data);
      }
    } catch {
      // Ignore
    }
  }

  if (!readyReceived) {
    throw new DeepSeekProtocolError(
      "DeepSeek completion stream did not contain ready event",
      { kind: "sse" }
    );
  }

  return {
    request_message_id: requestMessageId,
    response_message_id: responseMessageId,
    model_type: modelType,
    output_text: outputText,
    search_enabled: searchEnabled,
    search_triggered: searchTriggered,
    conversation_mode: conversationMode,
    events,
  };
}

// Delta parser - handles the DeepSeek JSON-patch-like delta format
function createDeltaParser(onText: (text: string) => void): (event: DeltaEvent) => void {
  let path = "";
  let operation: "SET" | "APPEND" = "SET";
  let fragmentType: string | undefined;
  const fragmentTypes = new Map<string, string>();

  const apply = (event: DeltaEvent, prefix = "", nested = false): void => {
    const eventPath = event.p ?? (nested ? "" : path);
    const eventOperation = event.o ?? (nested ? "SET" : operation);

    if (!nested) {
      path = eventPath;
      operation = eventOperation === "APPEND" ? "APPEND" : "SET";
    }

    if (eventOperation === "BATCH") {
      if (!Array.isArray(event.v)) return;
      for (const item of event.v) {
        if (item && typeof item === "object") {
          apply(item as DeltaEvent, eventPath ? `${prefix}${eventPath}/` : prefix, true);
        }
      }
      return;
    }

    const fullPath = `${prefix}${eventPath}`.replace(/\/+/g, "/").replace(/^\/+/, "");

    if (Array.isArray(event.v)) {
      const lastFragment = event.v[event.v.length - 1];
      if (
        lastFragment &&
        typeof lastFragment === "object" &&
        typeof (lastFragment as { type?: unknown }).type === "string"
      ) {
        const type = (lastFragment as { type: string }).type;
        fragmentType = type;
        fragmentTypes.set("-1", type);
      }
      for (const fragment of event.v) {
        if (
          fragment &&
          typeof fragment === "object" &&
          (fragment as { type?: string }).type === "RESPONSE" &&
          typeof (fragment as { content?: unknown }).content === "string"
        ) {
          onText((fragment as { content: string }).content);
        }
      }
      return;
    }

    if (fullPath === "response/fragments" && eventOperation === "APPEND" && Array.isArray(event.v)) {
      for (const fragment of event.v) {
        if (
          fragment &&
          typeof fragment === "object" &&
          (fragment as { type?: string }).type === "RESPONSE" &&
          typeof (fragment as { content?: unknown }).content === "string"
        ) {
          onText((fragment as { content: string }).content);
        }
      }
      return;
    }

    const fragmentMatch = fullPath.match(/^response\/fragments\/([^/]+)\/(type|content)$/);

    if (fullPath.endsWith("/type") && typeof event.v === "string") {
      fragmentType = event.v;
      if (fragmentMatch) fragmentTypes.set(fragmentMatch[1], event.v);
      return;
    }

    const contentFragmentType = fragmentMatch?.[2] === "content"
      ? fragmentTypes.get(fragmentMatch[1])
      : undefined;

    if (
      fullPath === "response/content" ||
      (fullPath.endsWith("/content") && (
        contentFragmentType === "RESPONSE" ||
        fragmentType === "RESPONSE"
      ))
    ) {
      if (typeof event.v !== "string") return;
      onText(event.v);
      return;
    }

    if (event.v && typeof event.v === "object") {
      const fragment = event.v as { type?: string; content?: unknown };
      if (fragment.type === "RESPONSE" && typeof fragment.content === "string") {
        onText(fragment.content);
        return;
      }

      const snapshot = event.v as {
        response?: { fragments?: Array<{ type?: string; content?: string | null }> };
        type?: string;
        content?: string | null;
      };

      const fragments = snapshot.response?.fragments;
      const lastFragment = fragments?.[fragments.length - 1];
      if (lastFragment?.type) fragmentType = lastFragment.type;

      if (fullPath.endsWith("/fragments/-1") && snapshot.type) {
        fragmentType = snapshot.type;
        fragmentTypes.set("-1", snapshot.type);
        if (snapshot.type === "RESPONSE" && typeof snapshot.content === "string") {
          onText(snapshot.content);
        }
      }
    }
  };

  return (event) => apply(event);
}