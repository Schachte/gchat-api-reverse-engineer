# Getting Full Cookies for Google Chat

The cookies provided (SID, SSID, HSID, OSID) are not enough - Google Chat requires additional authentication cookies.

## Method 1: Copy from Chrome DevTools (Recommended)

1. Open **chat.google.com** in Chrome and make sure you're logged in
2. Press **F12** to open DevTools
3. Go to **Network** tab
4. Refresh the page (F5)
5. Click on any request to `chat.google.com`
6. In the **Headers** section, find **Request Headers**
7. Find the **Cookie:** header and copy the ENTIRE value

It should look something like:
```
SID=xxx; HSID=xxx; SSID=xxx; APISID=xxx; SAPISID=xxx; __Secure-1PSID=xxx; __Secure-3PSID=xxx; __Secure-1PAPISID=xxx; __Secure-3PAPISID=xxx; NID=xxx; ...
```

## Method 2: Using EditThisCookie Extension

1. Install "EditThisCookie" Chrome extension
2. Go to chat.google.com
3. Click the cookie icon
4. Click "Export" (copies all cookies as JSON)

## Key Cookies Needed:

- `SID` - Session ID
- `HSID` - HTTP Session ID  
- `SSID` - Secure Session ID
- `APISID` - API Session ID
- `SAPISID` - Secure API Session ID (CRITICAL for API auth)
- `__Secure-1PSID` - Secure session
- `__Secure-3PSID` - Another secure session
- `__Secure-1PAPISID` - Secure API session (CRITICAL)
- `__Secure-3PAPISID` - Another secure API session

The `SAPISID` or `__Secure-1PAPISID` is especially important as it's used to generate the SAPISIDHASH authorization header.
