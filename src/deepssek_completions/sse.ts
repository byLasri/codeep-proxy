/**
 * DeepSeek SSE event types - modeling the actual event protocol
 */

// Raw SSE frame from the wire
export interface RawSSEFrame {
  event: string;
  dataText: string;
}

// Parsed DeepSeek event with typed data
export interface DeepSeekSSEEvent<T = unknown> {
  event: string;
  data: T;
}

// Event-specific data types

export interface ReadyEventData {
  request_message_id: number;
  response_message_id: number;
  model_type: string | null;
}

export interface UpdateSessionEventData {
  updated_at: number;
}

export interface TitleEventData {
  content: string;
}

export interface CloseEventData {
  click_behavior?: string;
  auto_resume?: boolean;
  [key: string]: unknown;
}

// Patch operation types for the data event
export type PatchOperation = 'SET' | 'APPEND' | 'BATCH' | string;

export interface DeepSeekPatch {
  p?: string;
  o?: PatchOperation;
  v?: unknown;
}

// Data event can contain either patches or a response object
export interface DataEventWithPatches {
  patches?: DeepSeekPatch[];
  // Also support direct patch fields at top level
  p?: string;
  o?: PatchOperation;
  // Or nested response object (union with unknown v)
  v?: unknown | {
    response?: {
      message_id?: number;
      parent_id?: number;
      role?: string;
      fragments?: DeepSeekPatch[];
      content?: string;
      status?: string;
    };
  };
}

// Unknown/unrecognized event data
export interface UnknownEventData {
  raw: unknown;
}

// Discriminated union for all DeepSeek event types
export type TypedDeepSeekEvent =
  | { type: 'ready'; data: ReadyEventData }
  | { type: 'update_session'; data: UpdateSessionEventData }
  | { type: 'data'; data: DataEventWithPatches }
  | { type: 'title'; data: TitleEventData }
  | { type: 'close'; data: CloseEventData }
  | { type: 'unknown'; eventName: string; data: UnknownEventData };

/**
 * Incremental SSE parser that handles arbitrary Uint8Array chunks
 * 
 * Design principles:
 * - One parser instance per HTTP response
 * - Persistent TextDecoder with stream: true for UTF-8 handling
 * - Buffer incomplete lines between chunks
 * - Handle \n and \r\n line endings
 * - Support multiple data: lines per event
 * - Blank line terminates an event
 * - finalize() called exactly once at EOF
 */
export class IncrementalSSEParser {
  private buffer = '';
  private currentEvent: { event?: string; dataLines: string[] } = { dataLines: [] };
  private decoder: TextDecoder;
  private finalized = false;

  constructor() {
    // Single persistent decoder for the entire stream
    this.decoder = new TextDecoder();
  }

  /**
   * Parse a chunk of bytes from the response body
   * Returns complete SSE events that can be fully parsed
   */
  parseChunk(chunk: Uint8Array): RawSSEFrame[] {
    if (this.finalized) {
      throw new Error('Parser already finalized');
    }

    const frames: RawSSEFrame[] = [];
    
    // Decode with streaming=true to handle UTF-8 splits
    const text = this.decoder.decode(chunk, { stream: true });
    this.buffer += text;
    
    let lineStart = 0;
    
    for (let i = 0; i < this.buffer.length; i++) {
      const char = this.buffer[i];
      
      // Handle both \n and \r\n
      if (char === '\n') {
        let lineEnd = i;
        if (i > lineStart && this.buffer[i - 1] === '\r') {
          lineEnd = i - 1;
        }
        
        const line = this.buffer.slice(lineStart, lineEnd);
        this.processLine(line, frames);
        lineStart = i + 1;
      }
    }
    
    // Keep any incomplete line in buffer for next chunk
    this.buffer = this.buffer.slice(lineStart);
    
    return frames;
  }

  private processLine(line: string, frames: RawSSEFrame[]): void {
    // Blank line terminates the current event
    if (line === '') {
      this.flushCurrentEvent(frames);
      return;
    }
    
    // Skip comment lines (start with :)
    if (line.startsWith(':')) {
      return;
    }
    
    // Parse field: value format
    const colonIndex = line.indexOf(':');
    if (colonIndex === -1) {
      // Line without colon - skip as malformed
      return;
    }
    
    const field = line.slice(0, colonIndex);
    const value = line.slice(colonIndex + 1);
    
    if (field === 'event') {
      this.currentEvent.event = value.trim();
    } else if (field === 'data') {
      // Multiple data: lines are joined with \n per SSE spec
      this.currentEvent.dataLines.push(value.trim());
    }
    // Ignore other fields (id, retry, etc.)
  }

  private flushCurrentEvent(frames: RawSSEFrame[]): void {
    if (this.currentEvent.dataLines.length === 0) {
      // No data to flush
      this.currentEvent = { dataLines: [] };
      return;
    }
    
    // Join multiple data lines with newline
    const dataText = this.currentEvent.dataLines.join('\n');
    
    frames.push({
      event: this.currentEvent.event ?? 'message',
      dataText: dataText,
    });
    
    // Reset for next event
    this.currentEvent = { dataLines: [] };
  }

  /**
   * Finalize parsing and return any remaining event
   * Must be called exactly once when the stream ends
   */
  finalize(): RawSSEFrame[] {
    if (this.finalized) {
      throw new Error('finalize() already called');
    }
    this.finalized = true;
    
    const frames: RawSSEFrame[] = [];
    
    // Flush any remaining event (even without trailing blank line)
    this.flushCurrentEvent(frames);
    
    return frames;
  }
}

/**
 * Parse raw SSE frames into typed DeepSeek events
 * Handles JSON parsing and event type discrimination
 */
export function parseDeepSeekEvents(frames: RawSSEFrame[]): TypedDeepSeekEvent[] {
  const events: TypedDeepSeekEvent[] = [];
  
  for (const frame of frames) {
    let data: unknown;
    let parseError: string | null = null;
    
    try {
      data = JSON.parse(frame.dataText);
    } catch (e) {
      // Log malformed JSON but don't silently discard
      parseError = e instanceof Error ? e.message : 'Unknown JSON parse error';
      data = { _parseError: parseError, rawText: frame.dataText };
    }
    
    // Map event name to typed event
    switch (frame.event) {
      case 'ready': {
        const readyData = data as ReadyEventData;
        // Validate required fields
        if (typeof readyData.request_message_id !== 'number' ||
            typeof readyData.response_message_id !== 'number') {
          // Still emit as ready but mark as potentially invalid
        }
        events.push({ type: 'ready', data: readyData });
        break;
      }
      case 'update_session': {
        events.push({ type: 'update_session', data: data as UpdateSessionEventData });
        break;
      }
      case 'title': {
        events.push({ type: 'title', data: data as TitleEventData });
        break;
      }
      case 'close': {
        events.push({ type: 'close', data: data as CloseEventData });
        break;
      }
      case 'data': {
        events.push({ type: 'data', data: data as DataEventWithPatches });
        break;
      }
      default: {
        // Unknown event type - preserve for diagnostics
        events.push({ 
          type: 'unknown', 
          eventName: frame.event,
          data: { raw: data }
        });
        break;
      }
    }
  }
  
  return events;
}

/**
 * Reconstructed response state from applying patches
 */
export interface ReconstructedResponse {
  messageId: number | null;
  parentId: number | null;
  role: string | null;
  status: string | null;
  content: string;
  reasoningContent: string;
  fragments: Array<{
    id?: number;
    type?: string;
    content: string;
  }>;
}

/**
 * Normalized completion events for the web client
 */
export type NormalizedCompletionEvent =
  | { type: 'ready'; requestMessageId: number; responseMessageId: number; modelType: string | null }
  | { type: 'content_delta'; text: string }
  | { type: 'reasoning_delta'; text: string }
  | { type: 'metadata'; key: string; value: unknown }
  | { type: 'completed'; finishReason: 'stop' | 'error' | 'unknown' };

/**
 * DeepSeek patch dispatcher that applies patches to reconstructed state
 */
export class PatchDispatcher {
  private state: ReconstructedResponse = {
    messageId: null,
    parentId: null,
    role: null,
    status: null,
    content: '',
    reasoningContent: '',
    fragments: [],
  };

  /**
   * Apply a single patch to the state
   */
  applyPatch(patch: DeepSeekPatch): void {
    const { p, o, v } = patch;
    
    if (!p || !o) {
      return; // Invalid patch
    }
    
    if (o === 'BATCH') {
      // Recursively apply batched patches
      if (Array.isArray(v)) {
        for (const subPatch of v) {
          if (this.isDeepSeekPatch(subPatch)) {
            this.applyPatch(subPatch);
          }
        }
      }
      return;
    }
    
    // Navigate to the target path
    const pathParts = p.split('/');
    
    if (o === 'SET') {
      this.setValueAtPath(pathParts, v);
    } else if (o === 'APPEND') {
      this.appendValueAtPath(pathParts, v);
    }
  }

  private isDeepSeekPatch(obj: unknown): obj is DeepSeekPatch {
    return typeof obj === 'object' && obj !== null && ('p' in obj || 'o' in obj || 'v' in obj);
  }

  private setValueAtPath(pathParts: string[], value: unknown): void {
    const currentPath = pathParts.join('/');
    
    // Handle specific known paths
    if (currentPath === 'response/status') {
      this.state.status = String(value ?? '');
    } else if (currentPath === 'response/content') {
      this.state.content = String(value ?? '');
    } else if (currentPath === 'response/fragments') {
      // SET on fragments array - replace entire array
      if (Array.isArray(value)) {
        this.state.fragments = value.map(f => ({
          id: typeof f.id === 'number' ? f.id : undefined,
          type: typeof f.type === 'string' ? f.type : undefined,
          content: typeof f.content === 'string' ? f.content : '',
        }));
      }
    } else if (currentPath.startsWith('response/fragments/') && currentPath.endsWith('/content')) {
      // SET on specific fragment content
      const indexStr = pathParts[2];
      const index = parseInt(indexStr, 10);
      if (!isNaN(index) && index >= 0 && index < this.state.fragments.length) {
        this.state.fragments[index].content = String(value ?? '');
      }
    }
  }

  private appendValueAtPath(pathParts: string[], value: unknown): void {
    const currentPath = pathParts.join('/');
    const strValue = String(value ?? '');
    
    if (currentPath === 'response/fragments/-1/content') {
      // Append to the last fragment's content
      if (this.state.fragments.length > 0) {
        const lastFragment = this.state.fragments[this.state.fragments.length - 1];
        lastFragment.content += strValue;
      } else {
        // Create a new fragment if none exists
        this.state.fragments.push({
          type: 'RESPONSE',
          content: strValue,
        });
      }
    } else if (currentPath === 'response/content') {
      // Append to root content
      this.state.content += strValue;
    } else if (currentPath === 'response/fragments') {
      // APPEND to fragments array
      if (Array.isArray(value)) {
        for (const item of value) {
          if (typeof item === 'object' && item !== null) {
            this.state.fragments.push({
              id: 'id' in item && typeof item.id === 'number' ? item.id : undefined,
              type: 'type' in item && typeof item.type === 'string' ? item.type : undefined,
              content: 'content' in item && typeof item.content === 'string' ? item.content : '',
            });
          }
        }
      }
    } else if (currentPath.startsWith('response/fragments/') && currentPath.endsWith('/content')) {
      // Append to specific fragment content
      const indexStr = pathParts[2];
      const index = parseInt(indexStr, 10);
      if (!isNaN(index) && index >= 0 && index < this.state.fragments.length) {
        this.state.fragments[index].content += strValue;
      }
    }
  }

  /**
   * Get the current reconstructed state
   */
  getState(): ReconstructedResponse {
    return { ...this.state, fragments: [...this.state.fragments] };
  }

  /**
   * Generate normalized deltas from a patch application
   */
  generateDeltas(patch: DeepSeekPatch): NormalizedCompletionEvent[] {
    const deltas: NormalizedCompletionEvent[] = [];
    const { p, o, v } = patch;
    
    if (!p || !o) {
      return deltas;
    }
    
    if (o === 'BATCH') {
      if (Array.isArray(v)) {
        for (const subPatch of v) {
          if (this.isDeepSeekPatch(subPatch)) {
            deltas.push(...this.generateDeltas(subPatch));
          }
        }
      }
      return deltas;
    }
    
    const strValue = String(v ?? '');
    
    // Only generate content deltas for APPEND operations on content paths
    if (o === 'APPEND') {
      if (p === 'response/fragments/-1/content' || p.endsWith('/content')) {
        // Check if this might be reasoning content based on fragment type
        const isReasoning = this.isReasoningPath(p);
        
        if (isReasoning && strValue) {
          deltas.push({ type: 'reasoning_delta', text: strValue });
        } else if (strValue) {
          deltas.push({ type: 'content_delta', text: strValue });
        }
      }
    }
    
    return deltas;
  }

  private isReasoningPath(path: string): boolean {
    // Check if the path or current state indicates reasoning content
    // Based on observed protocol, reasoning would be in a separate fragment type
    if (path.includes('reasoning')) {
      return true;
    }
    
    // Check the last fragment's type
    if (this.state.fragments.length > 0) {
      const lastFrag = this.state.fragments[this.state.fragments.length - 1];
      if (lastFrag.type === 'REASONING' || lastFrag.type === 'thinking') {
        return true;
      }
    }
    
    return false;
  }
}

/**
 * Convert typed DeepSeek events to normalized completion events
 */
export function normalizeDeepSeekEvents(events: TypedDeepSeekEvent[]): NormalizedCompletionEvent[] {
  const normalized: NormalizedCompletionEvent[] = [];
  const dispatcher = new PatchDispatcher();
  
  for (const event of events) {
    switch (event.type) {
      case 'ready': {
        normalized.push({
          type: 'ready',
          requestMessageId: event.data.request_message_id,
          responseMessageId: event.data.response_message_id,
          modelType: event.data.model_type,
        });
        break;
      }
      
      case 'update_session': {
        // Session metadata - emit as metadata event
        normalized.push({
          type: 'metadata',
          key: 'session_updated_at',
          value: event.data.updated_at,
        });
        break;
      }
      
      case 'title': {
        // Title metadata
        normalized.push({
          type: 'metadata',
          key: 'title',
          value: event.data.content,
        });
        break;
      }
      
      case 'data': {
        // Process patches in the data event
        const dataPayload = event.data;
        
        // Handle nested response object with fragments
        // Type guard for v being an object with response property
        const vObj = dataPayload.v as Record<string, unknown> | undefined;
        if (vObj?.response && typeof vObj.response === 'object' && vObj.response !== null) {
          const responseObj = vObj.response as { fragments?: DeepSeekPatch[] };
          if (responseObj.fragments) {
            for (const patch of responseObj.fragments) {
              dispatcher.applyPatch(patch);
              normalized.push(...dispatcher.generateDeltas(patch));
            }
          }
        }
        
        // Handle direct patch fields at top level
        if (dataPayload.p && dataPayload.o) {
          const patch: DeepSeekPatch = {
            p: dataPayload.p,
            o: dataPayload.o,
            v: dataPayload.v,
          };
          dispatcher.applyPatch(patch);
          normalized.push(...dispatcher.generateDeltas(patch));
        }
        
        // Handle patches array
        if (dataPayload.patches) {
          for (const patch of dataPayload.patches) {
            dispatcher.applyPatch(patch);
            normalized.push(...dispatcher.generateDeltas(patch));
          }
        }
        
        break;
      }
      
      case 'close': {
        normalized.push({
          type: 'completed',
          finishReason: 'stop',
        });
        break;
      }
      
      case 'unknown': {
        // Preserve unknown events as metadata for diagnostics
        normalized.push({
          type: 'metadata',
          key: `unknown_event_${event.eventName}`,
          value: event.data.raw,
        });
        break;
      }
    }
  }
  
  return normalized;
}

/**
 * Extract response_message_id from normalized events
 */
export function extractResponseMessageId(normalizedEvents: NormalizedCompletionEvent[]): number | null {
  for (const evt of normalizedEvents) {
    if (evt.type === 'ready') {
      return evt.responseMessageId;
    }
  }
  return null;
}

/**
 * Extract final content from reconstructed state
 */
export function extractFinalContent(state: ReconstructedResponse): string {
  // Prefer fragment content over root content
  if (state.fragments.length > 0) {
    return state.fragments.map(f => f.content).join('');
  }
  return state.content;
}

/**
 * Extract reasoning content from reconstructed state
 */
export function extractReasoningContent(state: ReconstructedResponse): string {
  const reasoningFragments = state.fragments.filter(f => 
    f.type === 'REASONING' || f.type === 'thinking'
  );
  return reasoningFragments.map(f => f.content).join('');
}
