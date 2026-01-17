# Key Terminology

This page defines important terms used throughout the codebase and documentation.

## Dynamite

**Dynamite** is Google's internal codename for Google Chat.

Historically, some clients refer to a “Dynamite token”. This repository authenticates using **browser cookies + an XSRF token** (from `/mole/world`) and does not require an OAuth-based token exchange.

## PBLite (Protobuf-Lite JSON)

**PBLite** is a JSON serialization format for Protocol Buffers that uses field numbers as keys instead of field names. This format is used by Google Chat's internal API.

### Standard JSON vs PBLite

```json
// Standard JSON (with field names)
{
  "requestHeader": {
    "clientType": 3,
    "locale": "en"
  }
}

// PBLite format (with field numbers)
{
  "1": {
    "2": 3,
    "4": "en"
  }
}
```

The numbers correspond to protobuf field definitions:

```protobuf
message RequestHeader {
  int32 client_type = 2;    // "2": 3 means client_type = WEB (enum value 3)
  string locale = 4;        // "4": "en" means locale = "en"
}
```

See [Protobuf & PBLite](reverse-engineering/protobuf-pblite.md) for detailed documentation.

## XSRF Token

The **XSRF (Cross-Site Request Forgery) token** is a security token required for all API calls. It's extracted from the `/mole/world` endpoint response.

In the code, you'll see it referenced as:

- `x-framework-xsrf-token` header in API requests
- `SMqcke` field in the `WIZ_global_data` JavaScript object

## Spaces and DMs

Google Chat has two types of conversations:

| Type | Description | Identifier |
|------|-------------|------------|
| **Space** | Group chat room with multiple members | `space_id` (11 chars, starts with `AAAA`) |
| **DM** | Direct message between two people | `dm_id` |

In the API, both are wrapped in a `GroupId` structure:

```json
{
  "1": { "1": "AAAA_spaceId" },  // space_id
  "3": { "1": "dmId" }           // dm_id (alternative)
}
```

## SAPISIDHASH

**SAPISIDHASH** is an authorization header format used for some Google API requests. It's computed as:

```
SAPISIDHASH {timestamp}_{sha1(timestamp + sapisid + origin)}
```

Where:

- `timestamp` is the current Unix timestamp in seconds
- `sapisid` is the value of the `SAPISID` cookie
- `origin` is the request origin (e.g., `https://chat.google.com`)

## Topics and Messages

In Google Chat's data model:

- **Topic**: A thread or conversation within a space. Contains one or more messages.
- **Message**: A single message within a topic. The first message creates the topic.

```
Space
├── Topic 1 (thread)
│   ├── Message 1 (original)
│   ├── Message 2 (reply)
│   └── Message 3 (reply)
└── Topic 2 (thread)
    └── Message 1 (original)
```

## Timestamps

Google Chat uses **microsecond timestamps** (not milliseconds). To convert to JavaScript Date:

```javascript
const usec = 1705420800000000;  // microseconds
const date = new Date(usec / 1000);  // divide by 1000 for milliseconds
```

## XSSI Protection

API responses are prefixed with `)]}'` to prevent JSON hijacking (XSSI - Cross-Site Script Inclusion). This prefix must be stripped before parsing:

```javascript
const text = await response.text();
const jsonStr = text.startsWith(")]}'") ? text.slice(5) : text;
const data = JSON.parse(jsonStr);
```

## Client Type

The `client_type` field in request headers identifies the client:

| Value | Type |
|-------|------|
| 1 | Android |
| 2 | iOS |
| 3 | Web |
| 4 | Bot |

This project uses `client_type: 3` (Web) to match browser behavior.
