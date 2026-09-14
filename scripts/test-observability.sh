#!/bin/bash
set -e

REPO_DIR="/workspace/github__byLasri__codeep-proxy"
LOG_FILE="$REPO_DIR/observability.log"
PORT=8788
WRANGLER_PID=""

# Clean up any previous log file
rm -f "$LOG_FILE"

# Function to kill wrangler on exit
trap "kill $WRANGLER_PID 2>/dev/null || true" EXIT

# Start wrangler dev in background
cd "$REPO_DIR"
echo "[Test] Starting wrangler dev on port $PORT..."
wrangler dev --port "$PORT" > "$LOG_FILE" 2>&1 &
WRANGLER_PID=$!
echo "[Test] Wrangler PID: $WRANGLER_PID"

# Wait for server to be ready
echo "[Test] Waiting for server to start..."
for i in {1..30}; do
  if curl -s -o /dev/null -f "http://localhost:$PORT/health"; then
    echo "[Test] Server is ready!"
    break
  fi
  sleep 1
done

# Check if server actually started
if ! curl -s -o /dev/null -f "http://localhost:$PORT/health"; then
  echo "[Test] ERROR: Server did not start within 30 seconds"
  cat "$LOG_FILE"
  exit 1
fi

# Send a mock OpenAI chat completion request
echo "[Test] Sending mock chat completion request..."
RESPONSE=$(curl -s -X POST "http://localhost:$PORT/v1/chat/completions" \
  -H "Content-Type: application/json" \
  -H "X-Session-Id: test-session-123" \
  -d '{
    "model": "deepseek-chat",
    "messages": [
      {"role": "user", "content": "Hello, world!"}
    ],
    "stream": false
  }' \
  -w "\nHTTP_STATUS:%{http_code}" \
  2>&1 || true)

echo "[Test] Request completed"
echo "[Test] Response preview: ${RESPONSE:0:200}"

# Wait a moment for logs to flush
sleep 2

# Kill wrangler
kill $WRANGLER_PID 2>/dev/null || true
wait $WRANGLER_PID 2>/dev/null || true
sleep 1

# Parse observability.log
echo ""
echo "=== OBSERVABILITY LOG VERIFICATION ==="
echo ""

# Check for [OBS] marker
OBS_COUNT=$(grep -c "\[OBS\]" "$LOG_FILE" || echo "0")
echo "[OBS] marker count: $OBS_COUNT"

# Check for event types
echo ""
echo "Checking for expected event types:"

# Check for incoming_request
INCOMING=$(grep -c '"event": "incoming_request"' "$LOG_FILE" || echo "0")
echo "  incoming_request: $INCOMING"

# Check for translated_request
TRANSLATED=$(grep -c '"event": "translated_request"' "$LOG_FILE" || echo "0")
echo "  translated_request: $TRANSLATED"

# Check for upstream_request
UPSTREAM_REQ=$(grep -c '"event": "upstream_request"' "$LOG_FILE" || echo "0")
echo "  upstream_request: $UPSTREAM_REQ"

# Check for upstream_response
UPSTREAM_RESP=$(grep -c '"event": "upstream_response"' "$LOG_FILE" || echo "0")
echo "  upstream_response: $UPSTREAM_RESP"

# Check for outgoing_to_client
OUTGOING=$(grep -c '"event": "outgoing_to_client"' "$LOG_FILE" || echo "0")
echo "  outgoing_to_client: $OUTGOING"

# Check for error
ERROR=$(grep -c '"event": "error"' "$LOG_FILE" || echo "0")
echo "  error: $ERROR"

# Summary
echo ""
echo "=== SUMMARY ==="
TOTAL=$((INCOMING + TRANSLATED + UPSTREAM_REQ + UPSTREAM_RESP + OUTGOING + ERROR))
echo "Total [OBS] events found: $TOTAL"

if [ "$OBS_COUNT" -gt 0 ]; then
  echo "✓ [OBS] marker found"
else
  echo "✗ [OBS] marker NOT found"
fi

if [ "$INCOMING" -gt 0 ]; then
  echo "✓ incoming_request event found"
else
  echo "✗ incoming_request event NOT found"
fi

if [ "$TRANSLATED" -gt 0 ]; then
  echo "✓ translated_request event found"
else
  echo "✗ translated_request event NOT found"
fi

if [ "$UPSTREAM_REQ" -gt 0 ]; then
  echo "✓ upstream_request event found"
else
  echo "✗ upstream_request event NOT found"
fi

if [ "$UPSTREAM_RESP" -gt 0 ]; then
  echo "✓ upstream_response event found"
else
  echo "✗ upstream_response event NOT found"
fi

if [ "$OUTGOING" -gt 0 ]; then
  echo "✓ outgoing_to_client event found"
else
  echo "✗ outgoing_to_client event NOT found"
fi

echo ""
echo "=== RAW LOG (filtered to [OBS] lines) ==="
grep "\[OBS\]" "$LOG_FILE" || echo "No [OBS] lines found"

echo ""
echo "[Test] Done!"
