#!/bin/bash
# Test script for DeepFree proxy

echo "=== Testing DeepFree Proxy ==="

# Test 1: Health check
echo -e "\n1. Health Check:"
curl -s http://localhost:8788/health | jq .

# Test 2: Models endpoint
echo -e "\n2. Models Endpoint:"
curl -s http://localhost:8788/v1/models | jq '.models[].slug'

# Test 3: Chat Completions (OpenAI compat)
echo -e "\n3. Chat Completions (non-streaming):"
curl -s -X POST http://localhost:8788/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"deepseek-chat","messages":[{"role":"user","content":"Say hello"}],"stream":false}' | jq .

# Test 4: Responses API (Codex native)
echo -e "\n4. Responses API (non-streaming):"
curl -s -X POST http://localhost:8788/v1/responses \
  -H "Content-Type: application/json" \
  -H "thread-id: test-thread-123" \
  -d '{"model":"deepseek-chat","input":"Say hello","stream":false}' | jq .

echo -e "\n=== Tests Complete ==="
