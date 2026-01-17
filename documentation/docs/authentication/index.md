# Authentication Overview

This project authenticates to Google Chat using browser cookies extracted from a logged-in session in your local browser.

## Cookie Authentication Flow

1. Extract cookies from your browser profile (SID/HSID/SSID/OSID/SAPISID)
2. Fetch an XSRF token from `/mole/world` (cached)
3. Make API calls with:
   - `Cookie: ...`
   - `x-framework-xsrf-token: ...`

See [Cookie Extraction](cookie-extraction.md) for implementation details.

## CLI

```bash
# Show cached XSRF token status (age/expiry)
cd packages/gchat && npm start -- auth status

# Force refresh auth/cookies
cd packages/gchat && npm start -- --refresh auth refresh
```

## Cache Files

Cache files are stored under `--cache-dir` (default: `~/.gchat` or `GCHAT_CACHE_DIR`):

- `cached_auth.json` - cached XSRF token (+ sessionId for batchexecute)
- `cached_cookies.json` - optional cookies cache (only used if you create it manually)

!!! warning "Security"
    These files contain sensitive authentication data. Keep them out of version control and restrict access to your local machine.
