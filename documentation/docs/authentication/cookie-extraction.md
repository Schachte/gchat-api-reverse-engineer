# Cookie-Based Authentication

This page documents the cookie extraction method used by the TypeScript client (`packages/gchat/src/core/auth.ts`).

## Overview

Cookie-based authentication extracts session cookies from Chrome and uses them to authenticate with Google Chat, bypassing the OAuth flow entirely.

## Required Cookies

The following cookies from `.google.com` are required:

| Cookie | Purpose |
|--------|---------|
| `SID` | Session ID |
| `HSID` | HTTP-only session ID |
| `SSID` | Secure session ID |
| `OSID` | Origin-bound session ID (from `chat.google.com`) |
| `SAPISID` | Used for SAPISIDHASH authorization |

## Cookie Extraction Methods

The client tries multiple extraction methods in order:

### 1. Manual `cookies.txt` File

Create a `cookies.txt` file with semicolon-separated key=value pairs:

```text
SID=abc123; HSID=def456; SSID=ghi789; OSID=jkl012; SAPISID=mno345;
```

### 2. Direct Browser Extraction

Attempts to read your browser cookie database directly (native extraction).

### 3. `@mherod/get-cookie` CLI (Fallback)

Falls back to the Node.js `@mherod/get-cookie` package:

```javascript
// From auth.ts - loadCookiesFromGetCookie()
const args = [
  GET_COOKIE_CLI,
  '%',              // All cookies
  'google.com',     // Domain
  '--output', 'json',
  '--browser', 'chrome',
  '--profile', profile
];
```

## XSRF Token Extraction

After obtaining cookies, fetch the XSRF token from `/mole/world`:

```typescript
// From auth.ts - fetchXsrfToken()
const url = `https://chat.google.com/u/0/mole/world?${params}`;

const response = await fetch(url, {
  method: 'GET',
  headers: {
    'Cookie': cookieString,
    'User-Agent': USER_AGENT,
    'Referer': 'https://mail.google.com/',
  },
  redirect: 'manual',
});

const body = await response.text();

// Extract WIZ_global_data from response
const wizMatch = body.match(/>window\.WIZ_global_data = ({.+?});<\/script>/s);
const wizData = JSON.parse(wizMatch[1]);

// XSRF token is in SMqcke field
const xsrfToken = wizData.SMqcke;  // e.g., "AFoagUXI..."
```

## SAPISIDHASH Generation

Some requests require a `SAPISIDHASH` authorization header:

```typescript
// From auth.ts - generateSAPISIDHash()
export async function generateSAPISIDHash(
  sapisid: string,
  origin: string = 'https://chat.google.com'
): Promise<string> {
  const timestamp = Math.floor(Date.now() / 1000);
  const input = `${timestamp} ${sapisid} ${origin}`;

  // SHA-1 hash using Web Crypto API
  const hashBuffer = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(input));
  const hashHex = Array.from(new Uint8Array(hashBuffer))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');

  return `SAPISIDHASH ${timestamp}_${hashHex}`;
}
```

The format is: `SAPISIDHASH {timestamp}_{sha1_hash}`

## Making API Requests

With cookies and XSRF token, make authenticated requests:

```typescript
// From client.ts - apiRequest()
const headers: Record<string, string> = {
  'Cookie': this.auth.cookieString,
  'User-Agent': USER_AGENT,
  'Content-Type': 'application/x-protobuf',
  'x-framework-xsrf-token': this.auth.xsrfToken,
};

const response = await fetch(url, {
  method: 'POST',
  headers,
  body: protoData,  // Binary protobuf
});
```

## Cache Files

Authentication data is cached to avoid repeated extraction:

### `cached_cookies.json`

Optional cookie cache (not required for normal CLI usage).

```json
{
  "SID": "abc123...",
  "HSID": "def456...",
  "SSID": "ghi789...",
  "OSID": "jkl012...",
  "SAPISID": "mno345..."
}
```

### `cached_auth.json`

```json
{
  "xsrf_token": "AFoagUXI...",
  "session_id": "....",
  "mole_world_body": "<html>...",
  "cached_at": 1705420800000
}
```

The XSRF token cache expires after 24 hours.

## Usage

```typescript
import { GoogleChatClient, auth } from 'gchat-cli';

// Get cookies (auto-extracts from Chrome if needed)
const cookies = auth.getCookies();

// Create client and authenticate
const client = new GoogleChatClient(cookies);
await client.authenticate();

// Use the client
const spaces = await client.listSpaces();
```

## CLI Usage

```bash
cd packages/gchat && npm start -- auth status
cd packages/gchat && npm start -- spaces
```

## Troubleshooting

!!! warning "No cookies found"
    Ensure you're logged into `chat.google.com` in Chrome Profile 1 (default), or create a `cookies.txt` file manually.

!!! warning "Auth failed: 302 redirect"
    Your session has expired. Log into Google Chat in Chrome and try again.

!!! warning "No XSRF token in response"
    The `/mole/world` endpoint may have changed. Check if the `WIZ_global_data` structure has been updated.

## Chrome Profile Selection

By default, the client uses Chrome Profile 1. To use a different profile:

```typescript
import { auth } from 'gchat-cli';

auth.setProfile('Profile 2');  // Use a different Chrome profile
```

Or use the CLI option:

```bash
cd packages/gchat && npm start -- --profile "Profile 2" spaces
```
