# Google Chat API Client

A Node.js client for Google Chat that uses the same authentication flow as [purple-googlechat](https://github.com/EionRobb/purple-googlechat).

## How it works

This client replicates the authentication flow from purple-googlechat:

1. **OAuth Login**: User authenticates via browser using Google's OAuth2 flow
2. **Token Exchange**: Authorization code is exchanged for `refresh_token` and `access_token`
3. **Dynamite Token**: The access token is exchanged for a "Dynamite" token via Google's internal token issuer
4. **API Access**: The Dynamite token is used to authenticate with Google Chat's internal API

## Setup

```bash
cd googlechat-client
npm install
```

## Authentication

Run the auth script to authenticate:

```bash
npm run auth
```

This will:
1. Open your browser to Google's login page
2. After login, Google shows you an authorization code
3. Paste the code into the terminal
4. Tokens are saved to `tokens.json`

## Usage

After authenticating, run the main script:

```bash
npm start
```

This will:
1. Refresh your tokens if needed
2. List your Google Chat spaces/DMs
3. Fetch recent messages from the first space

## API Overview

The client uses Google Chat's internal API endpoints:

- `GET /api/get_self_user_status` - Get current user info
- `POST /api/get_group_summaries` - List spaces/DMs
- `POST /api/list_topics` - Get messages in a space

### Request Format

Requests use a JSON format that maps to protobuf field numbers:

```javascript
{
  "1": {           // field 1 = RequestHeader
    "2": 3,        // field 2 = client_type (3 = WEB)
    "4": "en"      // field 4 = locale
  },
  "8": {           // field 8 = group_id
    "1": {         // field 1 = space_id
      "1": "spaceId123"
    }
  }
}
```

## Key Constants

From `libgooglechat.h`:

```javascript
const GOOGLE_CLIENT_ID = '936475272427.apps.googleusercontent.com';
const GOOGLE_CLIENT_SECRET = 'KWsJlkaMn1jGLxQpWxMnOox-';
const DYNAMITE_CLIENT_ID = '576267593750-sbi1m7khesgfh1e0f2nv5vqlfa4qr72m.apps.googleusercontent.com';
```

## Token Flow

```
Browser Login
     │
     ▼
Authorization Code
     │
     ▼ (exchangeCodeForTokens)
┌────────────────────┐
│ refresh_token      │ ◄── Save this, used to get new access tokens
│ access_token       │ ◄── Short-lived OAuth token  
│ id_token          │
└────────────────────┘
     │
     ▼ (getDynamiteToken)
┌────────────────────┐
│ dynamite_token     │ ◄── Used for Chat API calls
│ expiresIn          │     (typically ~1 hour)
└────────────────────┘
```

## Notes

- Tokens expire and need to be refreshed (the client handles this automatically)
- The Dynamite token is the actual credential used for API requests
- The API uses protobuf under the hood, but accepts JSON with numeric field keys
- Field numbers in JSON correspond to protobuf field definitions in `googlechat.proto`

## Disclaimer

This uses unofficial/internal Google APIs. Use at your own risk and be aware that:
- The API could change at any time
- This may violate Google's Terms of Service
- This is for educational/personal use only
