# Chrome Network Tutorial

This step-by-step tutorial shows how to capture and decode Google Chat API requests using Chrome DevTools. We'll use `list_topics` as our example.

## Prerequisites

- Google Chrome browser
- Logged into `chat.google.com`
- Basic understanding of [PBLite format](protobuf-pblite.md)

## Step 1: Setup Chrome DevTools

1. Open `https://chat.google.com` in Chrome
2. Press **F12** (or Cmd+Option+I on Mac) to open DevTools
3. Click the **Network** tab
4. Ensure "Preserve log" is checked
5. Filter by "Fetch/XHR" to reduce noise

![Network Tab Setup](https://via.placeholder.com/600x300?text=DevTools+Network+Tab)

## Step 2: Capture the Request

1. In Google Chat, click on a space/room to view messages
2. In DevTools, look for a request to `list_topics`
3. Click on the request to view details

You should see something like:

```
Name: list_topics?alt=protojson&key=AIzaSyD7InnYR3VKdb4j2rMUEbTCIr2VyEazl6k
Status: 200
Type: fetch
```

## Step 3: Examine Request Headers

Click the **Headers** tab to see:

```http
POST /api/list_topics?alt=protojson&key=AIzaSyD7InnYR3VKdb4j2rMUEbTCIr2VyEazl6k HTTP/1.1
Host: chat.google.com
Content-Type: application/x-protobuf
Cookie: SID=...; HSID=...; ...
x-framework-xsrf-token: AFoagUXI...
```

Key observations:

- **Method**: POST
- **Content-Type**: `application/x-protobuf` (binary protobuf)
- **Query params**: `alt=protojson` returns JSON instead of binary
- **Headers**: Cookie + XSRF token required

## Step 4: Decode the Request Body

Click the **Payload** tab. If the body is binary, you may see:

```
(binary data)
```

To see readable data, we need to look at what we're sending. Based on reverse engineering, the `ListTopicsRequest` structure is:

```protobuf
message ListTopicsRequest {
  RequestHeader request_header = 1;
  int32 page_size_for_topics = 2;
  int32 page_size_for_replies = 3;
  int32 page_size_for_unread_replies = 6;
  int32 page_size_for_read_replies = 7;
  GroupId group_id = 8;
  ReferenceRevision group_not_older_than = 9;
}
```

Which translates to this PBLite structure:

```json
{
  "1": { "2": 3, "4": "en" },     // request_header
  "2": 25,                         // page_size_for_topics
  "3": 10,                         // page_size_for_replies
  "6": 5,                          // page_size_for_unread_replies
  "7": 5,                          // page_size_for_read_replies
  "8": {                           // group_id
    "1": {                         // space_id
      "1": "AAAAabcdefg"           // the actual space ID
    }
  }
}
```

## Step 5: Decode the Response

Click the **Response** tab. You'll see something like:

```
)]}'
[["dfe.t.lt",[[[null,"topic123",[["AAAAabc"],null,["dm123"]],null,...
```

### Step 5.1: Strip the XSSI Prefix

The `)]}'` prefix prevents JSON hijacking. Remove it:

```javascript
const text = response;
const json = text.replace(/^\)\]\}'/, '').trim();
```

### Step 5.2: Parse the JSON

```javascript
const data = JSON.parse(json);
// data = [["dfe.t.lt", [...], null, null, true, true]]
```

### Step 5.3: Understand the Structure

```javascript
const wrapper = data[0];
// wrapper[0] = "dfe.t.lt"    // Response type identifier
// wrapper[1] = [...]         // Array of topics
// wrapper[4] = true          // containsFirstTopic
// wrapper[5] = true          // containsLastTopic
```

### Step 5.4: Parse Topics

Each topic in `wrapper[1]` has this structure:

```javascript
const topic = wrapper[1][0];
// topic[0] = [null, "topic_id_123", [["space_id"]]]  // Topic ID info
// topic[1] = "1705420800000000"                      // Sort timestamp (microseconds)
// topic[6] = [[...messages...]]                      // Array of messages
```

### Step 5.5: Parse Messages

Each message has this structure:

```javascript
const message = topic[6][0];
// message[0] = [null, "message_id"]        // Message ID
// message[1] = [["user_id"], "User Name"]  // Sender info
// message[2] = "1705420800000000"          // Timestamp
// message[9] = "Hello, world!"             // Message text
// message[10] = [[...annotations...]]      // Mentions, links, etc.
```

## Step 6: Implement in Code

### TypeScript Encoder (`packages/gchat/src/core/proto.ts`)

```typescript
export function encodeListTopicsRequest(
  spaceId: string,
  options: { pageSize?: number; cursor?: number } = {}
): Uint8Array {
  const { pageSize = 25, cursor } = options;

  const root = loadProto();
  const ListTopicsRequest = root.lookupType('ListTopicsRequest');

  const payload: Record<string, unknown> = {
    requestHeader: createRequestHeader(),
    pageSizeForTopics: pageSize,
    pageSizeForReplies: 10,
    pageSizeForUnreadReplies: 5,
    pageSizeForReadReplies: 5,
    groupId: {
      spaceId: { spaceId: spaceId },
    },
  };

  if (cursor) {
    payload.groupNotOlderThan = { timestamp: cursor };
  }

  const message = ListTopicsRequest.create(payload);
  return ListTopicsRequest.encode(message).finish();
}
```

### TypeScript Parser (`packages/gchat/src/core/client.ts`)

```typescript
private parseTopicsResponse(data: unknown[], spaceId: string): ThreadsResult {
  const topics: Topic[] = [];
  const messages: Message[] = [];

  // Extract topics from data[0][1]
  if (Array.isArray(data) && Array.isArray(data[0]) && Array.isArray(data[0][1])) {
    for (const topicData of data[0][1]) {
      const topic = this.extractTopic(topicData);
      if (topic) {
        topics.push(topic);
        messages.push(...topic.replies);
      }
    }
  }

  // Extract pagination flags
  const containsFirstTopic = data[0]?.[4] === true;
  const containsLastTopic = data[0]?.[5] === true;

  return {
    messages,
    topics,
    pagination: {
      contains_first_topic: containsFirstTopic,
      contains_last_topic: containsLastTopic,
      has_more: !containsFirstTopic,
    },
  };
}
```

## Step 7: Test Your Implementation

```bash
# Using the TypeScript client
cd packages/gchat
npx tsx src/main.ts messages AAAA_your_space_id
```

Compare your output with the raw response in Chrome DevTools to verify correctness.

## Tips for Reverse Engineering

### Finding Field Meanings

1. **Change one thing**: Modify a single value and observe the change
2. **Compare responses**: Same action, different inputs
3. **Look for patterns**: Timestamps are large numbers, IDs are strings
4. **Check edge cases**: Empty arrays, null values, missing fields

### Common Response Patterns

| Pattern | Likely Meaning |
|---------|----------------|
| `"AAAA..."` (11 chars) | Space ID |
| `1705420800000000` (16 digits) | Timestamp in microseconds |
| `[null, "string"]` | ID with prefix slot |
| `[["id"], "name"]` | User info |
| `true`/`false` at end | Pagination flags |

### When Things Break

1. **Clear caches**: Delete `cached_auth.json` under `--cache-dir` (default: `~/.gchat`)
2. **Re-authenticate**: Get fresh cookies
3. **Compare with browser**: Check if structure changed
4. **Check DevTools**: Look for new fields or different endpoints

## Example: Discovering Pagination

By scrolling up in a chat to load older messages, you can observe:

1. A new `list_topics` request with a `cursor` parameter
2. The cursor value matches `oldestTimestamp` from previous response
3. Response includes `containsFirstTopic: false` when more exist

This led to implementing pagination:

```typescript
// Pagination: use oldest timestamp as cursor
if (result.pagination.has_more) {
  const olderTopics = await client.getThreads(spaceId, {
    cursor: result.pagination.next_cursor
  });
}
```

## Summary

1. **Capture**: Use Chrome DevTools Network tab
2. **Decode Request**: Map field numbers to proto definitions
3. **Decode Response**: Strip XSSI, parse JSON, understand structure
4. **Implement**: Encode with protobufjs, parse with array indexing
5. **Test**: Compare your output with browser behavior
