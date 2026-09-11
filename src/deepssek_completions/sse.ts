/**
 * DeepSeek SSE event types
 */

export interface DeepSeekSSEEvent {
  event: string;
  data: unknown;
}

export interface ReadyEvent {
  request_message_id: number;
  response_message_id: number;
  model_type: string | null;
}

export interface UpdateSessionEvent {
  updated_at: number;
}

export interface DataEventFragment {
  p?: string;
  o?: 'SET' | 'APPEND' | 'BATCH';
  v?: unknown;
}

export interface DataEvent {
  v: {
    response?: {
      message_id: number;
      parent_id: number;
      role: string;
      fragments?: DataEventFragment[];
      content?: string;
    };
  };
}

export interface CloseEvent {
  code: number;
  reason?: string;
}

/**
 * Incremental SSE parser that handles arbitrary Uint8Array chunks
 */
export class IncrementalSSEParser {
  private buffer = '';
  private currentEvent: { event?: string; data?: string } = {};
  private events: DeepSeekSSEEvent[] = [];

  /**
   * Parse a chunk of bytes from the response body
   */
  parseChunk(chunk: Uint8Array): DeepSeekSSEEvent[] {
    const decoder = new TextDecoder();
    this.buffer += decoder.decode(chunk, { stream: true });
    
    const events: DeepSeekSSEEvent[] = [];
    let lineStart = 0;
    
    for (let i = 0; i < this.buffer.length; i++) {
      if (this.buffer[i] === '\n') {
        const line = this.buffer.slice(lineStart, i);
        this.processLine(line, events);
        lineStart = i + 1;
      }
    }
    
    // Keep any incomplete line in buffer
    this.buffer = this.buffer.slice(lineStart);
    
    return events;
  }

  private processLine(line: string, events: DeepSeekSSEEvent[]): void {
    const trimmed = line.trim();
    
    if (trimmed === '') {
      // Empty line marks end of event
      if (this.currentEvent.data !== undefined) {
        try {
          events.push({
            event: this.currentEvent.event ?? 'message',
            data: JSON.parse(this.currentEvent.data),
          });
        } catch {
          // Skip malformed JSON
        }
      }
      this.currentEvent = {};
    } else if (trimmed.startsWith('event: ')) {
      this.currentEvent.event = trimmed.slice(7).trim();
    } else if (trimmed.startsWith('data: ')) {
      this.currentEvent.data = trimmed.slice(6).trim();
    }
  }

  /**
   * Finalize parsing and return any remaining event
   */
  finalize(): DeepSeekSSEEvent[] {
    const events: DeepSeekSSEEvent[] = [];
    
    // Handle last event if no trailing newline
    if (this.currentEvent.data !== undefined) {
      try {
        events.push({
          event: this.currentEvent.event ?? 'message',
          data: JSON.parse(this.currentEvent.data),
        });
      } catch {
        // Skip malformed JSON
      }
    }
    
    return events;
  }
}

/**
 * Parse a single SSE line into an event
 */
export function parseSSELine(line: string): { event?: string; data?: string } | null {
  if (line.startsWith('event: ')) {
    return { event: line.slice(7).trim() };
  }
  if (line.startsWith('data: ')) {
    return { data: line.slice(6).trim() };
  }
  return null;
}

/**
 * Parse complete SSE events from raw text (legacy, for testing)
 */
export function parseSSEEvents(rawText: string): DeepSeekSSEEvent[] {
  const events: DeepSeekSSEEvent[] = [];
  const lines = rawText.split('\n');
  
  let currentEvent: { event?: string; data?: string } = {};
  
  for (const line of lines) {
    const trimmed = line.trim();
    
    if (trimmed === '') {
      // Empty line marks end of event
      if (currentEvent.data !== undefined) {
        try {
          events.push({
            event: currentEvent.event ?? 'message',
            data: JSON.parse(currentEvent.data),
          });
        } catch {
          // Skip malformed JSON
        }
      }
      currentEvent = {};
    } else {
      const parsed = parseSSELine(trimmed);
      if (parsed) {
        if (parsed.event !== undefined) {
          currentEvent.event = parsed.event;
        }
        if (parsed.data !== undefined) {
          currentEvent.data = parsed.data;
        }
      }
    }
  }
  
  // Handle last event if no trailing newline
  if (currentEvent.data !== undefined) {
    try {
      events.push({
        event: currentEvent.event ?? 'message',
        data: JSON.parse(currentEvent.data),
      });
    } catch {
      // Skip malformed JSON
    }
  }
  
  return events;
}

/**
 * Extract response_message_id from ready event
 */
export function extractResponseMessageId(events: DeepSeekSSEEvent[]): number | null {
  for (const evt of events) {
    if (evt.event === 'ready') {
      const ready = evt.data as Partial<ReadyEvent>;
      if (typeof ready.response_message_id === 'number') {
        return ready.response_message_id;
      }
    }
  }
  return null;
}

/**
 * Extract content deltas from data events for OpenAI translation
 * Uses canonical extraction: prefers fragments[].v over response.content to avoid duplication
 */
export function extractContentDeltas(events: DeepSeekSSEEvent[]): string[] {
  const deltas: string[] = [];
  
  for (const evt of events) {
    if (evt.event === 'data') {
      const dataEvt = evt.data as DataEvent;
      const response = dataEvt.v?.response;
      
      if (response?.fragments) {
        for (const frag of response.fragments) {
          if (frag.o === 'APPEND' && typeof frag.v === 'string') {
            deltas.push(frag.v);
          }
        }
      } else if (response?.content && typeof response.content === 'string') {
        // Only use direct content if no fragments present (avoid duplication)
        deltas.push(response.content);
      }
    }
  }
  
  return deltas;
}
