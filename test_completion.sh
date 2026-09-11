#!/bin/bash
# Test the completion endpoint with a real request

echo "Testing streaming completion..."
curl -X POST http://localhost:3568/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "deepseek-chat",
    "messages": [{"role": "user", "content": "What is 2+2?"}],
    "stream": true
  }' --no-buffer

echo ""
echo "Testing non-streaming completion..."
curl -X POST http://localhost:3568/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "deepseek-chat",
    "messages": [{"role": "user", "content": "What is 2+2?"}],
    "stream": false
  }'
