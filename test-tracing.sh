#!/bin/bash

# Test Agent Tracing API
# Usage: ./test-tracing.sh YOUR_API_TOKEN

API_TOKEN="${1:-YOUR_API_TOKEN_HERE}"
BASE_URL="${2:-http://localhost:3000}"

if [ "$API_TOKEN" = "YOUR_API_TOKEN_HERE" ]; then
  echo "❌ Please provide your API token as the first argument"
  echo "Usage: ./test-tracing.sh YOUR_API_TOKEN [BASE_URL]"
  exit 1
fi

echo "🚀 Testing Agent Tracing API..."
echo "📍 URL: $BASE_URL/api/client/tracing/sessions"
echo "🔑 Token: ${API_TOKEN:0:10}..."
echo ""

SESSION_ID="test_session_$(date +%s)"
TIMESTAMP=$(date -u +%Y-%m-%dT%H:%M:%SZ)

curl -X POST "$BASE_URL/api/client/tracing/sessions" \
  -H "Authorization: Bearer $API_TOKEN" \
  -H "Content-Type: application/json" \
  -d @- << EOF
{
  "sessionId": "$SESSION_ID",
  "agent": {
    "name": "test-assistant",
    "version": "1.0.0",
    "model": "gpt-4"
  },
  "config": {
    "temperature": 0.7,
    "maxTokens": 2000
  },
  "status": "success",
  "startedAt": "$TIMESTAMP",
  "endedAt": "$TIMESTAMP",
  "durationMs": 5000,
  "summary": {
    "totalInputTokens": 800,
    "totalOutputTokens": 400,
    "totalBytesIn": 3000,
    "totalBytesOut": 1500,
    "eventCounts": {
      "llm_call": 2,
      "tool_call": 1
    }
  },
  "errors": [],
  "events": [
    {
      "id": "evt_1",
      "type": "llm_call",
      "label": "Initial query processing",
      "sequence": 1,
      "timestamp": "$TIMESTAMP",
      "status": "success",
      "actor": {
        "name": "gpt-4",
        "role": "llm",
        "scope": "model"
      },
      "model": "gpt-4",
      "durationMs": 1500,
      "inputTokens": 500,
      "outputTokens": 250,
      "metadata": {
        "temperature": 0.7
      }
    },
    {
      "id": "evt_2",
      "type": "tool_call",
      "label": "Database search",
      "sequence": 2,
      "timestamp": "$TIMESTAMP",
      "status": "success",
      "actor": {
        "name": "database_search",
        "role": "tool",
        "scope": "tool"
      },
      "toolName": "database_search",
      "toolExecutionId": "exec_123",
      "durationMs": 850,
      "metadata": {
        "query": "user preferences"
      }
    },
    {
      "id": "evt_3",
      "type": "llm_call",
      "label": "Generate response",
      "sequence": 3,
      "timestamp": "$TIMESTAMP",
      "status": "success",
      "actor": {
        "name": "gpt-4",
        "role": "llm",
        "scope": "model"
      },
      "model": "gpt-4",
      "durationMs": 2100,
      "inputTokens": 300,
      "outputTokens": 150,
      "metadata": {
        "temperature": 0.7
      }
    }
  ]
}
EOF

echo ""
echo ""
echo "✅ Test completed! Check your Agent Tracing dashboard at:"
echo "   $BASE_URL/dashboard/tracing"
