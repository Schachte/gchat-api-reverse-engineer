# Repository Layout

This page documents the structure and purpose of files in the repository.

## Directory Structure

```
google-chat-api/
├── packages/
│   └── gchat/              # TypeScript library + CLI + HTTP server (bin: gchat)
│       ├── openapi/        # OpenAPI spec (served at /openapi.json|.yaml)
│       ├── public/         # Web UI static assets (served at /ui)
│       ├── src/            # TypeScript source
│       │   ├── app/        # Shared runtime helpers (client factory, cache)
│       │   ├── cli/        # CLI program (command wiring)
│       │   ├── core/       # Core client/channel/auth/proto implementation
│       │   ├── server/     # HTTP API server implementation
│       │   └── utils/      # Higher-level utilities (export/stay-online)
│       ├── test/           # Vitest unit tests
│       ├── package.json
│       └── tsconfig.json
│
├── documentation/          # MkDocs documentation (you are here)
│   ├── docs/
│   ├── mkdocs.yml
│   └── serve.sh
│
├── package.json            # Root scripts (dev/build/docs)
└── README.md
```

## TypeScript Package (`packages/gchat/`)

### `packages/gchat/src/core/auth.ts`

Cookie-based authentication:

- Extracts cookies from a logged-in browser profile (or `cookies.txt`)
- Fetches an XSRF token from `/mole/world`
- Caches auth under `--cache-dir` (default `~/.gchat` or `GCHAT_CACHE_DIR`)

### `packages/gchat/src/core/client.ts`

Main `GoogleChatClient` class with methods:

```typescript
class GoogleChatClient {
  // Spaces
  async listSpaces(): Promise<Space[]>
  async listSpacesPaginated(...): Promise<SpacesResult>

  // Threads / messages
  async getThreads(spaceId, options): Promise<ThreadsResult>
  async getThread(spaceId, topicId): Promise<ThreadResult>
  async getAllMessages(spaceId, options): Promise<AllMessagesResult>

  // Cursor-based list_topics pagination (JSON/PBLite)
  async fetchTopicsWithServerPagination(...): Promise<...>

  // Search
  async searchInSpace(spaceId, query): Promise<SearchMatch[]>
  async searchAllSpaces(query): Promise<SearchMatch[]>

  // Send
  async sendMessage(spaceId, text): Promise<SendMessageResult>
  async replyToThread(spaceId, topicId, text): Promise<SendMessageResult>

  // User
  async getSelfUser(): Promise<SelfUser>
}
```

### `packages/gchat/src/core/proto.ts`

Protobuf encoding using `protobufjs`:

```typescript
export function encodePaginatedWorldRequest(pageSize): Uint8Array
export function encodeListTopicsRequest(spaceId, options): Uint8Array
export function encodeListMessagesRequest(spaceId, topicId): Uint8Array
export function encodeGetMembersRequest(userIds): Uint8Array
export function encodeCreateTopicRequest(spaceId, text): Uint8Array
export function encodeCreateMessageRequest(spaceId, topicId, text): Uint8Array
```

## Configuration Files

Authentication data is cached to avoid repeated cookie extraction and `/mole/world` fetches.

### Cache directory

Stored under `--cache-dir` (default `~/.gchat`):

- `cached_auth.json` – cached XSRF token (+ session ID when available)
- `cached_cookies.json` – optional cookies cache (only used if you create it manually)

## OpenAPI Specification

If the `packages/gchat/openapi/` folder exists, the server will serve:

- `/openapi.json`
- `/openapi.yaml`

These are used by the Scalar UI at `/docs`.
