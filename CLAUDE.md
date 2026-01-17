# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

A TypeScript/Node.js client + CLI for Google Chat’s internal API. This is a reverse-engineered unofficial API — endpoints and authentication may change without notice.

Google Chat has no official API for personal accounts. The official Google Chat API requires Workspace and is for bots only.

## Key Terminology

- **Dynamite**: Google's internal codename for Google Chat.
- **PBLite**: JSON format using protobuf field numbers as keys (e.g., `{"1": {"2": 3}}` instead of `{"header": {"type": 3}}`).
- **XSRF Token**: Cross-site request forgery token from `/mole/world`, required for API calls.
- **Space**: A group chat room (has `space_id`). **DM**: Direct message (has `dm_id`).

## Commands

```bash
# Install root dependencies (docs/dev helpers)
npm install

# Main package (CLI + server)
cd packages/gchat && npm install
cd packages/gchat && npm run build

# Run built CLI
cd packages/gchat && npm start -- spaces

# Run API server (built)
npm run serve

# Hot reload server (tsx watch)
npm run dev

# Run tests
npm test
```

## Architecture

### Single Implementation Path (TypeScript)

Everything lives under `packages/gchat/`:

Key files:

- `packages/gchat/src/core/auth.ts` – cookie extraction + XSRF bootstrap (`/mole/world`) + cache (`--cache-dir`, default `~/.gchat`)
- `packages/gchat/src/core/client.ts` – `GoogleChatClient` core API methods (spaces, threads, send/reply, presence, etc.)
- `packages/gchat/src/core/channel.ts` – WebChannel client for real-time events + pings
- `packages/gchat/src/cli/program.ts` – `gchat` CLI commands + handlers (includes `presence` command using `playwright-core` + `storageState` auth)
- `packages/gchat/src/server/api-server.ts` – HTTP JSON API server + UI routing
- `packages/gchat/src/utils/*` – higher-level utilities built on top of the core client/channel APIs

## Key Constants

```javascript
API_KEY = 'AIzaSyD7InnYR3VKdb4j2rMUEbTCIr2VyEazl6k'  // Python client
```

## Request Format Example

Requests use JSON with numeric keys mapping to protobuf field numbers:

```javascript
{
  "1": {           // RequestHeader
    "2": 3,        // client_type: WEB
    "4": "en"      // locale
  },
  "8": {           // group_id
    "1": { "1": "spaceId123" }
  }
}
```

## Pagination

### Working Cursor Pagination (JSON/PBLite list_topics)

The protobuf `list_topics` request format has unreliable cursor pagination. For large exports, use the JSON/PBLite `list_topics` request format (matching the web client), which supports cursor-based pagination.

Key discovery: the cursor is the **sort_time timestamp** of the last topic, not a topic ID.

Implementation:

- `GoogleChatClient.fetchTopicsWithServerPagination()` – single page + cursor metadata
- `utils.exportChatBatches()` – iterates pages, supports resume + optional full-thread expansion

Notes:

- The cursor is a microsecond timestamp string; the implementation uses `cursor - 1` to avoid duplicates.
- `anchorTimestamp` must be preserved across pages.
