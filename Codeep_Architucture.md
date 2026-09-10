# Codeep Architecture

## Introduction

Codeep is designed as a layered system with a strict separation between the DeepSeek Web protocol, response interpretation, conversation state, and the Codeep/OpenAI-facing application layer.

The core principle is simple: **each module is stateless, agnostic, and specialized in one responsibility only**.

The DeepSeek protocol layer must reproduce the observed DeepSeek Web protocol accurately and reliably, while remaining independent of Codeep application logic. Higher layers may interpret responses, maintain conversation state, translate formats, and expose the public API.

## 1. Contract

The architecture contract defines the boundary that every layer must respect.

### 1.1 DeepSeek Protocol Layer

**Responsibility:** talk to DeepSeek Web and implement its protocol correctly.

It is responsible for:

- establishing the required DeepSeek session/protocol prerequisites;
- obtaining and using the required authentication credentials supplied by the caller;
- creating and solving Proof-of-Work challenges when required by the protocol;
- constructing DeepSeek Web requests exactly according to the verified protocol;
- sending requests through the standard Web `fetch()` API;
- returning the resulting raw HTTP `Response` to the caller.

It must **not**:

- parse SSE completion data;
- interpret model output;
- maintain conversation state;
- persist sessions or messages;
- know about OpenAI/Codeep request or response formats;
- decide application-level model behavior;
- own authentication storage or credential persistence.

The protocol layer receives all state and configuration it needs from its caller. It does not keep conversation state internally.

### 1.2 Response Parser Layer

**Responsibility:** interpret DeepSeek responses.

This layer consumes the raw `Response` returned by the protocol layer and parses the response format, including SSE/data events where applicable.

It must not perform network requests or maintain conversation state.

### 1.3 Conversation Layer

**Responsibility:** maintain conversation state outside the stateless protocol implementation.

This layer owns values such as `chat_session_id` and `parent_message_id`, determines what state must be supplied for the next request, and may persist that state when required by the application.

### 1.4 Codeep/Application Layer

**Responsibility:** expose Codeep's public API and application behavior.

This layer translates between Codeep/OpenAI-compatible formats and the DeepSeek-specific protocol, selects modes/models, manages application sessions, and coordinates the protocol and parser layers.

### 1.5 Dependency Direction

The intended dependency direction is:

```text
Codeep / Application
        |
        v
Conversation / State
        |
        v
DeepSeek Response Parser
        |
        v
DeepSeek Protocol / Transport
        |
        v
      DeepSeek Web
```

The DeepSeek protocol layer must remain independent of the layers above it.

### 1.6 Cloudflare Worker Contract

The DeepSeek implementation must remain compatible with the Cloudflare Workers runtime. Prefer standard Web APIs such as `fetch()`, `Request`, `Response`, `Headers`, `ReadableStream`, `TextEncoder`, and `TextDecoder`.

Node-specific APIs, filesystem access, process-global application state, or server-specific networking libraries must not be introduced into the protocol layer when a Web-standard API can perform the required operation.

### 1.7 Verification Rule

Protocol behavior must be based on observed and verified DeepSeek Web traffic, especially HAR captures and captured responses, rather than assumptions about how the service works.

When protocol behavior is uncertain, the implementation must treat the captured traffic as the source of truth and document unresolved behavior rather than silently inventing semantics.
