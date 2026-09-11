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
 * Parse complete SSE events from raw text
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
 */
export function extractContentDeltas(events: DeepSeekSSEEvent[]): string[] {
  const deltas: string[] = [];
  
  for (const evt of events) {
    if (evt.event === 'data') {
      const dataEvt = evt.data as DataEvent;
      if (dataEvt.v?.response?.fragments) {
        for (const frag of dataEvt.v.response.fragments) {
          if (frag.o === 'APPEND' && typeof frag.v === 'string') {
            deltas.push(frag.v);
          }
        }
      }
      // Also handle direct content field
      if (dataEvt.v?.response?.content && typeof dataEvt.v.response.content === 'string') {
        deltas.push(dataEvt.v.response.content);
      }
    }
  }
  
  return deltas;
}
