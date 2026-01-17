# Logging & Debugging

The CLI includes a professional logging system for debugging and troubleshooting.

## Log Levels

| Level | Description |
|-------|-------------|
| `silent` | No output |
| `error` | Only errors |
| `warn` | Errors and warnings |
| `info` | Standard operational messages (default) |
| `debug` | Detailed debugging information |

## Enabling Debug Output

### Command Line Flags

```bash
# Enable debug mode (sets log level to debug)
gchat --debug spaces

# Set specific log level
gchat --log-level debug spaces
gchat --log-level warn notifications
```

### Environment Variable

```bash
# Set log level via environment variable
LOG_LEVEL=debug gchat spaces

# Or export for the session
export LOG_LEVEL=debug
gchat spaces
```

## Debug Output Examples

### Normal Output (info level)

```bash
$ gchat spaces
============================================================
 Found 12 spaces
============================================================
...
```

### Debug Output

```bash
$ gchat --debug spaces
[2024-01-17T10:30:00.123Z] [DEBUG] [CLI] CACHE_DIR: /Users/you/google-chat-api
[2024-01-17T10:30:00.124Z] [DEBUG] [Auth] Loading cookies from Chrome...
[2024-01-17T10:30:00.156Z] [DEBUG] [Auth] Found 3 cookies for chat.google.com
[2024-01-17T10:30:00.157Z] [DEBUG] [Client] Authenticating with Google Chat...
[2024-01-17T10:30:00.234Z] [DEBUG] [Client] Fetching XSRF token from /mole/world
[2024-01-17T10:30:00.456Z] [DEBUG] [Client] XSRF token obtained
[2024-01-17T10:30:00.457Z] [DEBUG] [Client] API request: POST /api/get_group_summaries
[2024-01-17T10:30:00.789Z] [DEBUG] [Client] Response: 200 OK (332ms)
============================================================
 Found 12 spaces
============================================================
...
```

## Log Components

The logging system uses component prefixes to identify the source:

| Component | Description |
|-----------|-------------|
| `CLI` | Command-line interface operations |
| `Client` | API client requests and responses |
| `Channel` | WebChannel/streaming operations |
| `Auth` | Authentication and cookie handling |
| `Server` | HTTP server operations |
| `WS` | WebSocket connections |
| `API` | API endpoint handlers |

## Troubleshooting

### Authentication Issues

```bash
# Debug authentication flow
gchat --debug --refresh spaces
```

Look for:
- Cookie extraction messages
- XSRF token fetch status
- Authentication API responses

### API Errors

```bash
# Debug API requests
gchat --debug messages SPACE_ID
```

The debug output shows:
- Request URLs and methods
- Request/response timing
- Error details and status codes

### WebSocket/Channel Issues

```bash
# Debug real-time streaming
gchat --debug api
```

Channel debug output includes:
- WebChannel protocol messages
- Event parsing details
- Connection state changes

## Programmatic Logging

When using the client library programmatically:

```typescript
import { setLogLevel, log } from '@anthropic/gchat';

// Set global log level
setLogLevel('debug');

// Use component loggers
log.client.debug('Custom debug message');
log.auth.info('Auth status:', status);
log.api.error('API error:', error);
```

### Creating Custom Loggers

```typescript
import { createLogger } from '@anthropic/gchat';

const myLogger = createLogger('MyApp');
myLogger.info('Application started');
myLogger.debug('Debug info:', data);
```

## Disabling Colors

For CI/CD or piping output:

```bash
# Disable colors
gchat --no-color spaces

# Or with environment variable
NO_COLOR=1 gchat spaces
```

## Common Issues

### "Cookie extraction failed"

1. Ensure Chrome is fully closed
2. Use `--profile` to select the correct profile
3. Make sure you're logged into chat.google.com in that profile

```bash
# List profiles first
gchat profiles

# Use specific profile
gchat --profile "Default" --refresh spaces
```

### "XSRF token fetch failed"

1. Cookies may be expired - use `--refresh`
2. Check debug output for HTTP status codes
3. Verify you can access chat.google.com in your browser

```bash
gchat --debug --refresh spaces
```

### "Space not found"

1. Verify the space ID is correct
2. Use `find-space` to search by name
3. Check if you have access to the space

```bash
gchat find-space "team"
gchat --debug messages CORRECT_SPACE_ID
```
