# Codeep Architecture

Codeep is a proxy that connects its public interface to external AI services. We are currently building the DeepSeek side of the proxy first.

The architecture is intentionally simple: each module should have one clear job, remain stateless where possible, and not mix responsibilities with other parts of the proxy.

## 1. DeepSeek Protocol

The first module is the **DeepSeek Protocol** layer.

Its single job is to **talk to DeepSeek Web correctly**.

It owns the technical details required to communicate with the DeepSeek Web endpoint, including:

- establishing the required session/protocol prerequisites;
- handling authentication supplied to it;
- handling Proof-of-Work when required;
- building the requests required by the DeepSeek Web protocol;
- sending them to DeepSeek;
- returning the raw HTTP response.

This module does **not** interpret the response, manage conversations, or contain Codeep/OpenAI logic.

The protocol implementation must be based on the behavior we verify from DeepSeek Web traffic and HAR captures, not assumptions.
