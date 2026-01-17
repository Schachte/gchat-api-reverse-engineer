# Reverse Engineering Overview

This project reverse-engineers Google Chat's internal API because there is **no official API for personal accounts**. The official Google Chat API requires a Google Workspace account and is designed only for bots.

## Why Reverse Engineer?

| Official API | This Project |
|--------------|--------------|
| Requires Workspace | Works with personal accounts |
| Bot-only access | Full user access |
| Limited features | All features available |
| Documented | Requires reverse engineering |

## Heritage

This project builds on the work of [purple-googlechat](https://github.com/EionRobb/purple-googlechat), a Pidgin plugin that reverse-engineered the authentication flow. Key discoveries from that project:

- The internal API endpoint structure
- Protobuf schemas and field-number mappings used by the web client
- Practical patterns for request/response parsing (XSSI stripping, PBLite-like payloads)

## Reverse Engineering Approach

### 1. Network Traffic Analysis

The primary tool is Chrome DevTools Network tab:

1. Open `chat.google.com`
2. Open DevTools (F12) → Network tab
3. Perform actions in the UI
4. Analyze captured requests/responses

### 2. Understanding PBLite

Google uses PBLite (Protocol Buffer Lite) format - JSON with field numbers instead of names:

```json
// What we see
{ "1": { "2": 3, "4": "en" } }

// What it means
{ "requestHeader": { "clientType": "WEB", "locale": "en" } }
```

See [Protobuf & PBLite](protobuf-pblite.md) for detailed documentation.

### 3. Proto Definition Discovery

Field meanings are discovered through:

- Analyzing consistent patterns in responses
- Comparing request/response pairs
- Examining Google's public protobuf definitions
- Trial and error

### 4. Implementation

Once understood, implement the encoding/decoding:

```typescript
// Encode request
const protoData = encodeListTopicsRequest(spaceId, { pageSize: 25 });

// Make API call
const response = await apiRequest('list_topics', protoData);

// Parse response
const topics = parseTopicsResponse(response);
```

## Tools Used

| Tool | Purpose |
|------|---------|
| Chrome DevTools | Network traffic capture |
| protobufjs | JavaScript protobuf encoding |
| JSON formatters | Analyzing PBLite structure |

## Key Discoveries

### API Endpoints

All API calls go to `https://chat.google.com/api/`:

| Endpoint | Purpose |
|----------|---------|
| `list_topics` | Get messages in a space |
| `list_messages` | Get messages in a thread |
| `paginated_world` | List all spaces/DMs |
| `get_self_user_status` | Current user info |
| `get_members` | User details |
| `create_topic` | Send new message |
| `create_message` | Reply to thread |

### Request Format

```
POST /api/{endpoint}?alt=protojson&key={API_KEY}
Content-Type: application/x-protobuf
Cookie: {session_cookies}
x-framework-xsrf-token: {xsrf_token}

{binary protobuf body}
```

### Response Format

Responses are JSON with an XSSI protection prefix:

```
)]}'
[["dfe.t.lt", [...data...], null, null, true, true]]
```

## Ethical Considerations

!!! warning "Terms of Service"
    Using unofficial APIs may violate Google's Terms of Service. This project is intended for:

    - Personal use
    - Educational purposes
    - Research

    Do not use for:

    - Commercial applications
    - Spam or abuse
    - Violating user privacy

!!! info "Stability"
    As an unofficial API, endpoints and authentication may change without notice. This project requires ongoing maintenance as Google updates their systems.

## Getting Started

1. Read [Protobuf & PBLite](protobuf-pblite.md) to understand the data format
2. Follow the [Chrome Network Tutorial](chrome-network-tutorial.md) to capture your own requests
3. Examine the source code in `packages/gchat/src/core/proto.ts` and `packages/gchat/src/core/client.ts`
