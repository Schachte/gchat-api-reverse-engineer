# Protobuf & PBLite Format

This page explains Protocol Buffers and the PBLite JSON format used by Google Chat's internal API.

## What is Protocol Buffers?

[Protocol Buffers](https://protobuf.dev/) (protobuf) is Google's language-neutral data serialization format. Messages are defined in `.proto` files:

```protobuf
message RequestHeader {
  int32 client_type = 2;
  int64 client_version = 3;
  string locale = 4;
}
```

Each field has:

- A **type** (`int32`, `string`, `message`, etc.)
- A **name** (`client_type`, `locale`, etc.)
- A **field number** (`= 2`, `= 4`, etc.)

## What is PBLite?

**PBLite** (Protocol Buffer Lite) is a JSON serialization format where field numbers are used as keys instead of field names:

```json
// PBLite format
{
  "1": { "2": 3, "4": "en" }
}

// Equivalent standard JSON
{
  "requestHeader": { "clientType": 3, "locale": "en" }
}
```

This format:

- Is more compact (shorter keys)
- Requires knowing the proto definition to understand
- Is used by Google's internal JavaScript libraries

## Field Number Mapping

### RequestHeader Example

```protobuf
// Proto definition
message RequestHeader {
  int32 client_type = 2;      // Field 2
  int64 client_version = 3;   // Field 3
  string locale = 4;          // Field 4
}
```

```json
// PBLite encoding
{
  "2": 3,        // client_type = 3 (WEB)
  "4": "en"      // locale = "en"
}
```

### GroupId Example

```protobuf
message GroupId {
  SpaceId space_id = 1;
  DmId dm_id = 3;
}

message SpaceId {
  string space_id = 1;
}
```

```json
// Space
{
  "1": { "1": "AAAAabcdefg" }
}

// DM
{
  "3": { "1": "dm_id_here" }
}
```

## Array Representation

In PBLite, messages can also be represented as arrays where the index (+1) is the field number:

```javascript
// Array format (0-indexed, so index 0 = field 1)
[null, 3, null, "en"]
//     ^2        ^4 (field numbers, with nulls for missing fields)

// Object format (explicit field numbers)
{ "2": 3, "4": "en" }
```

The response from Google Chat typically uses the array format:

```javascript
[["dfe.t.lt",    // Index 0: Response type identifier
  [...topics...], // Index 1: Topic data
  null,           // Index 2: unused
  null,           // Index 3: unused
  true,           // Index 4: containsFirstTopic
  true            // Index 5: containsLastTopic
]]
```

## Encoding in TypeScript

The `packages/gchat/src/core/proto.ts` file uses `protobufjs` to encode requests:

```typescript
// Proto schema defined inline
const PROTO_SCHEMA = `
message ListTopicsRequest {
  RequestHeader request_header = 1;
  int32 page_size_for_topics = 2;
  int32 page_size_for_replies = 3;
  GroupId group_id = 8;
}
`;

// Load and encode
const root = protobuf.parse(PROTO_SCHEMA).root;
const ListTopicsRequest = root.lookupType('ListTopicsRequest');

const message = ListTopicsRequest.create({
  requestHeader: createRequestHeader(),
  pageSizeForTopics: 25,
  pageSizeForReplies: 10,
  groupId: {
    spaceId: { spaceId: spaceId }
  }
});

const encoded = ListTopicsRequest.encode(message).finish();
// Returns Uint8Array (binary protobuf)
```

## Parsing in TypeScript

This repository primarily treats PBLite as nested arrays/objects and extracts known indices/fields.

Implementation references:

- `packages/gchat/src/core/client.ts` – `buildListTopicsPayload()`, `parseListTopicsResponse()`, `parsePbliteMessage()`
- `packages/gchat/src/core/proto.ts` – protobuf encoders for endpoints that accept binary protobuf

Example (cursor extraction from `list_topics` JSON/PBLite response):

```ts
// data[0] is the response envelope, data[0][1] is the topics array.
const topics = Array.isArray(data?.[0]?.[1]) ? data[0][1] : [];

// Cursor state for the next page.
const nextTimestampCursor = data?.[0]?.[2]?.[0] ?? null;
const anchorTimestamp = data?.[0]?.[3]?.[0] ?? null;
```

## Common Patterns

### Nested Messages

```json
{
  "1": {           // request_header (field 1)
    "2": 3,        // client_type (field 2)
    "4": "en"      // locale (field 4)
  },
  "8": {           // group_id (field 8)
    "1": {         // space_id (field 1)
      "1": "AAAA..." // space_id string (field 1)
    }
  }
}
```

### Repeated Fields (Arrays)

```json
{
  "1": [           // repeated items
    ["item1", 123],
    ["item2", 456]
  ]
}
```

### Enum Values

Enums are encoded as integers:

```protobuf
enum ClientType {
  UNKNOWN = 0;
  ANDROID = 1;
  IOS = 2;
  WEB = 3;
  BOT = 4;
}
```

```json
{ "2": 3 }  // client_type = WEB
```

## Dictionary Extension

High field numbers are sometimes stored in a trailing dictionary:

```javascript
// Array with dictionary extension
[value1, value2, ..., { "100": valueFor100, "101": valueFor101 }]
```

One common parsing pattern is to detect a trailing object and treat it as an “extension map” keyed by field number:

```ts
const last = pblite[pblite.length - 1];
const extension =
  last && typeof last === 'object' && !Array.isArray(last)
    ? (last as Record<string, unknown>)
    : undefined;
```

## Response Type Identifiers

Responses often start with a type identifier string:

| Identifier | Meaning |
|------------|---------|
| `dfe.t.lt` | ListTopics response |
| `dfe.t.lm` | ListMessages response |
| `dfe.t.pw` | PaginatedWorld response |
| `dfe.ust.gsus` | GetSelfUserStatus response |

These are typically at index 0 and should be skipped when parsing.

## Debugging Tips

1. **Pretty print**: Use `JSON.stringify(data, null, 2)` to format responses
2. **Compare**: Make the same action in the browser and compare requests
3. **Guess and check**: Try different field values and observe results
4. **Use proto definitions**: Reference `packages/gchat/src/core/proto.ts` for known fields

## References

- [Google's Closure PBLite](https://github.com/nicknisi/nicknisi.github.com/blob/master/pblite.md)
- [Protocol Buffers Documentation](https://protobuf.dev/)
- [protobufjs Documentation](https://protobufjs.github.io/protobuf.js/)
