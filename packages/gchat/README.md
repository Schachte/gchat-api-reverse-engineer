# Google Chat CLI Client

A TypeScript CLI client for Google Chat using reverse-engineered APIs.

## Installation

```bash
cd packages/gchat
npm install
npm run build

# Optional: install `gchat` on your PATH for local development
npm link
```

## Testing

```bash
cd packages/gchat
npm test

# watch mode
npm run test:watch
```

## Authentication

The CLI extracts cookies from your browser automatically. To verify auth status:

```bash
gchat auth status

# If you didn't run `npm link`, use:
# npm start -- auth status
```

To force refresh auth/cookies:

```bash
gchat --refresh auth refresh
```

## Built Files

After running `npm run build`, compiled output is generated in `dist/`:

- `dist/cli.js` - CLI entry point
- `dist/index.js` - library entry point
- `dist/core/*`, `dist/utils/*`, `dist/server/*` - implementation modules

## CLI Usage

```bash
# List all spaces
gchat spaces

# Get messages from a space
gchat messages SPACE_ID
gchat messages SPACE_ID -n 50    # Get 50 messages

# Get threaded messages with pagination
gchat threads SPACE_ID
gchat threads SPACE_ID -p 3              # 3 pages
gchat threads SPACE_ID --full            # Full thread contents
gchat threads SPACE_ID -p 5 --full       # 5 pages, full threads

# Get a specific thread
gchat thread SPACE_ID TOPIC_ID

# Search messages
gchat search "query"                     # All spaces
gchat search "query" -s SPACE_ID         # Specific space

# Find spaces by name
gchat find-space "team"

# List unreads/mentions/DMs
gchat notifications

# Include all world items and dump raw data
gchat notifications --all --dump-auth
```

### API Server + Experimental UI

```bash
# Start the API server (includes Scalar docs + experimental UI)
gchat api --host localhost --port 3000
```

- Scalar API docs: `http://localhost:3000/docs`
- Experimental UI: `http://localhost:3000/ui`

### Global Options

| Option | Description |
|--------|-------------|
| `--json` | Output as JSON |
| `-b, --browser <type>` | Browser to use (chrome, brave, edge, chromium, arc) |
| `-p, --profile <name>` | Browser profile to use |
| `--cookie-path <path>` | Custom cookie DB path |
| `--cache-dir <path>` | Cache directory for auth state (default: `~/.gchat` or `GCHAT_CACHE_DIR`) |
| `--refresh` | Force refresh authentication |
| `--no-color` | Disable colored output |
| `--debug` | Enable debug logging |
| `--log-level <level>` | Set log level (error, warn, info, debug, silent) |
| `-V, --version` | Output version number |
| `-h, --help` | Display help |

### Command Reference

| Command | Description |
|---------|-------------|
| `spaces` | List all spaces |
| `messages <space_id>` | Get messages from a space (`-n` for limit) |
| `threads <space_id>` | Get threaded messages (`-p` pages, `-s` page size, `--full`, `--cursor`) |
| `thread <space_id> <topic_id>` | Get all messages in a specific thread |
| `search <query>` | Search messages (`-s` to limit to specific space) |
| `find-space <query>` | Search for spaces by name |
| `notifications` | List unread counts, mentions, and direct messages (`--all`, `--dump-auth`) |
| `export <space_id>` | Export history to JSON (batched, resumable) |
| `stay-online` | Keep presence online (WebChannel) |

### Examples

```bash
# Output spaces as JSON
gchat --json spaces

# Use a custom cookie database path (browser must be closed)
gchat --cookie-path "/path/to/Cookies" spaces

# Force re-authentication
gchat --refresh spaces

# Fetch 5 pages of threads with full conversation history
gchat threads SPACE_ID -p 5 --full

# Search in a specific space
gchat search "meeting notes" -s SPACE_ID
```

## Programmatic Usage

```typescript
import { GoogleChatClient, utils } from 'gchat-cli';

const cookies = {
  SID: '...',
  HSID: '...',
  // ...
};

const client = new GoogleChatClient(cookies);
await client.authenticate();

// List spaces
const spaces = await client.listSpaces();

// Get threaded messages
const result = await client.getThreads(spaceId, {
  pageSize: 25,
  fetchFullThreads: true,
});

// Get a specific thread
const thread = await client.getThread(spaceId, topicId);

// Search
const matches = await client.searchAllSpaces('query');

// Export topics/messages in batches (e.g., last 7 days)
for await (const batch of utils.exportChatBatches(client, spaceId, { since: '7d', pageSize: 100 })) {
  console.log('batch', batch.page, 'topics', batch.topics.length, 'messages', batch.messages.length);
}

// Stay online (presence keep-alive)
const session = await utils.startStayOnline(client, {
  subscribe: true,
  pingIntervalSec: 60,
  onEvent: (evt) => console.log(evt.type, evt.timestamp),
});

// Stop later:
// session.stop();
await session.done;
```

## API Methods

### `listSpaces(): Promise<Space[]>`
List all spaces the user belongs to.

### `getThreads(spaceId, options): Promise<ThreadsResult>`
Get messages from a space with threading and pagination.

Options:
- `pageSize`: Topics per page (default: 25)
- `cursor`: Pagination cursor (from previous response)
- `repliesPerTopic`: Max replies per topic (default: 10)
- `fetchFullThreads`: Fetch ALL messages in each thread (slower but complete)

### `getThread(spaceId, topicId): Promise<ThreadResult>`
Get all messages in a specific thread.

### `getAllMessages(spaceId, options): Promise<AllMessagesResult>`
Fetch multiple pages of messages.

Options:
- `maxPages`: Maximum pages to fetch (default: 10)
- `pageSize`: Topics per page (default: 25)
- `fetchFullThreads`: Fetch full thread contents

### `searchInSpace(spaceId, query): Promise<SearchMatch[]>`
Search messages in a specific space.

### `searchAllSpaces(query): Promise<SearchMatch[]>`
Search messages across all spaces.

### `findSpaces(query): Promise<Space[]>`
Find spaces by name.

## Logging & Debugging

The client uses structured logging with configurable levels for debugging.

### Log Levels

| Level | Description |
|-------|-------------|
| `silent` | No output |
| `error` | Errors only |
| `warn` | Warnings and errors |
| `info` | Normal operation (default) |
| `debug` | Verbose debug output |

### Configuration

**Via CLI flag:**
```bash
# Enable debug logging
gchat --debug spaces

# Set specific log level
gchat --log-level debug api
gchat --log-level warn spaces
```

**Via environment variable:**
```bash
# Set log level
LOG_LEVEL=debug gchat api

# Silence all logging
LOG_LEVEL=silent gchat spaces
```

### Programmatic Usage

```typescript
import { setLogLevel, createLogger } from 'gchat-cli';

// Set global log level
setLogLevel('debug');

// Create a custom logger for your code
const myLogger = createLogger('MyApp');
myLogger.info('Starting...');
myLogger.debug('Details:', { foo: 'bar' });
myLogger.error('Something failed:', error);
```

### Log Output Format

Logs are formatted with timestamp, level, component, and message:
```
12:34:56.789 INFO  [Server] Google Chat API Server running at http://localhost:3000
12:34:56.790 DEBUG [Channel] Connecting to WebChannel...
12:34:57.123 ERROR [API] Request failed: 401 Unauthorized
```

### Debugging Tips

1. **API Issues**: Use `--log-level debug` to see request/response details
2. **WebSocket Issues**: Debug logs show channel events and reconnection attempts
3. **Auth Issues**: Check auth logs for cookie loading and XSRF token fetching
