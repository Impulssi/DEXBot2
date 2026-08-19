# memU Proactive Memory for DEXBot2

memU provides 24/7 always-on proactive memory for AI agents integrated with DEXBot2. It captures user intent, reduces LLM token costs, and enables context-aware trading assistance.

## Overview

memU treats memory like a file system — structured, hierarchical, and instantly accessible:

| File System | memU Memory |
|-------------|-------------|
| Folders | Categories (auto-organized topics) |
| Files | Memory Items (extracted facts, preferences, skills) |
| Symlinks | Cross-references (related memories linked) |
| Mount points | Resources (conversations, documents, images) |

## Memory Hierarchy

```
memory/
├── preferences/
│   ├── communication_style.md
│   └── trading_preferences.md
├── relationships/
│   ├── contacts/
│   └── interaction_history/
├── knowledge/
│   ├── domain_expertise/
│   └── trading_strategies/
└── context/
    ├── recent_conversations/
    └── pending_tasks/
```

## Prerequisites

- Python 3.13+
- memU package: `pip install memu-py`
- LLM API key (OpenAI, OpenRouter, etc.)

## Available Tools

### Core Memory Operations

| Tool | Description | Required Args |
|------|-------------|---------------|
| `memu_memorize` | Store a resource as memory | `resourceUrl`, `modality` |
| `memu_retrieve` | Query stored memories | `queries` |
| `memu_list_categories` | List memory categories | none |
| `memu_list_items` | List memory items | none |
| `memu_create_item` | Create a memory item directly | `categoryId` or `categoryName`, `summary` |
| `memu_status` | Get memU service status | none |

### Trading-Specific Operations

| Tool | Description | Required Args |
|------|-------------|---------------|
| `memu_memorize_conversation` | Memorize a conversation | `messages` |
| `memu_memorize_trading_context` | Memorize trading context | `context` |
| `memu_retrieve_trading_context` | Retrieve trading memories | `query` |

## Modalities

| Modality | Use Case |
|----------|----------|
| `conversation` | Chat logs, user-bot interactions |
| `document` | Trading reports, market analysis, bot configs |
| `image` | Chart screenshots, price graphs |
| `video` | Trading tutorials, market commentary |
| `audio` | Voice notes, trading calls |

## Usage Examples

### Memorize a Conversation

```json
{
  "tool": "memu_memorize_conversation",
  "arguments": {
    "messages": [
      {"role": "user", "content": "I prefer BTS/USD grid bots with 2% increment"},
      {"role": "assistant", "content": "I'll configure a grid bot with those settings"}
    ],
    "user": {"user_id": "trader-123"}
  }
}
```

### Memorize Trading Context

```json
{
  "tool": "memu_memorize_trading_context",
  "arguments": {
    "context": {
      "bot": "BTS/USD-grid",
      "event": "price_dropped_5_percent",
      "action_taken": "rebalanced_grid",
      "timestamp": "2026-05-18T10:30:00Z"
    },
    "user": {"user_id": "trader-123"}
  }
}
```

### Retrieve Trading Context

```json
{
  "tool": "memu_retrieve_trading_context",
  "arguments": {
    "query": "What are my preferences for BTS/USD grid bots?",
    "user": {"user_id": "trader-123"}
  }
}
```

### Retrieve with LLM Deep Reasoning

```json
{
  "tool": "memu_retrieve",
  "arguments": {
    "queries": [
      {"role": "user", "content": {"text": "How should I adjust my grid based on recent market behavior?"}}
    ],
    "method": "llm",
    "where": {"user_id": "trader-123"}
  }
}
```

## Integration with DEXBot2 Claw

The memU bridge integrates with the DEXBot2 claw subsystem:

### CLI Usage

```bash
# From claw/ directory
npm run memu:status
npm run memu:mcp  # Start MCP server
```

### MCP Server Configuration

For Hermes:

```yaml
mcp_servers:
  memu:
    command: "node"
    args: ["/path/to/DEXBot2/dist/claw/scripts/memu_mcp_server.js", "--memu-dir", "/path/to/claw/data/memu"]
```

For NanoBot/PicoClaw:

```bash
node ../dist/claw/scripts/memu_mcp_server.js --memu-dir /path/to/claw/data/memu
```

## Proactive Memory Patterns

### Pattern 1: Learning User Preferences

When the user mentions trading preferences:

1. Extract the preference from the conversation
2. Call `memu_memorize_conversation` to store it
3. On future interactions, call `memu_retrieve_trading_context` to recall preferences

### Pattern 2: Trading Event Memory

When significant trading events occur:

1. Call `memu_memorize_trading_context` with event details
2. Store bot actions, market conditions, and outcomes
3. Later, retrieve to inform similar decisions

### Pattern 3: Context-Aware Assistance

Before responding to trading queries:

1. Call `memu_retrieve_trading_context` with the query
2. Use retrieved context to provide personalized responses
3. Reference past decisions and preferences

## Memory Types

| Type | Description |
|------|-------------|
| `profile` | User preferences and settings |
| `knowledge` | Factual information about markets, assets |
| `skill` | Learned trading strategies and techniques |
| `behavior` | Interaction patterns and habits |
| `event` | Specific trading events and outcomes |
| `tool` | Tool call memory and outcomes |

## Best Practices

1. **Scope memories to users**: Always pass `user` with `user_id` when multiple users share the system
2. **Use appropriate modalities**: Choose the right modality for the content type
3. **Retrieve before acting**: Check existing memories before making recommendations
4. **Use RAG for speed, LLM for depth**: `method: "rag"` is fast, `method: "llm"` provides deeper reasoning
5. **Clean up old memories carefully**: Prefer scoped `memu_clear` calls such as `{"where":{"user_id":"trader-123"}}` on shared systems

## Environment Variables

| Variable | Description |
|----------|-------------|
| `OPENAI_API_KEY` | OpenAI API key for LLM operations |
| `MEMU_PYTHON` | Path to Python interpreter (default: `python3`) |

## Notes

- memU runs as a Python subprocess bridge from Node.js
- Memory is persisted to SQLite under `claw/data/memu` by default
- For production, configure PostgreSQL with pgvector for persistent storage
- The MCP server uses stdio transport with newline-delimited JSON-RPC
