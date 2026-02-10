# Google Chat API (Unofficial)

Google Chat doesn't have an official API for personal/consumer accounts. This repo is a reverse‑engineered TypeScript/Node.js client that talks to the same internal endpoints the web app uses (`chat.google.com`) so you can automate your own Chat account locally.

## Features


- **CLI (`gchat`)**
  - Search messages
  - List 
    - spaces
    - DMs
    - threads
    - messages
  - Send 
    - Channel messages
    - Private messages
    - Thread replies
  - Misc
    - Batch data exporter for spaces and DMs
    - Stay online (keep yourself logged online)
    - Browser-based presence (`gchat presence`) via Playwright + storageState
- **Local HTTP API server**
  - JSON endpoints for the same operations as the CLI
  - Web UI at `/ui`
  - API docs (Scalar) at `/docs`
- **TypeScript library**
  - `GoogleChatClient` for programmatic use
  - `utils` for higher-level workflows:
    - `utils.startStayOnline()` – maintain presence via WebChannel + refresh
    - `utils.exportChatBatches()` – cursor-based export batching for large spaces
- **Cookie-based authentication**
  - Uses cookies from an already logged-in browser profile + an XSRF token from `/mole/world`
  - Cache defaults to `~/.gchat` (override with `--cache-dir` or `GCHAT_CACHE_DIR`)

## Run Docs

**Project Documentation:**
```bash
npm run dev:docs
```
Access at `http://127.0.0.1:8000`

**OpenAPI Docs**
```bash
npm run dev
```
Access at `http://localhost:3000/docs`

## Run UI

Start the HTTP API server with web interface:

**Development (hot reload):**
```bash
npm run dev
```

**Production:**
```bash
npm run serve
```

**With custom browser or profile:**
```bash
npm run dev -- --browser brave --profile "Profile 5"
```

- UI: `http://localhost:3000/ui`
- API Docs: `http://localhost:3000/docs`

Supported browsers: `chrome`, `brave`, `edge`, `chromium`, `arc`

## Run CLI

Navigate to the CLI package and run commands:

```bash
cd packages/gchat

# Check auth status
npm start -- auth status

# List spaces
npm start -- spaces

# Send a message
npm start -- send <space_id> "Your message"

# Export space (last 7 days)
npm start -- export <space_id> --since 7d --full-threads

# Stay online
npm start -- stay-online
```

**With custom browser or profile:**
```bash
npm start -- --browser brave --profile "Profile 5" spaces
```

Supported browsers: `chrome`, `brave`, `edge`, `chromium`, `arc`

---

Disclaimer: this uses unofficial/internal Google APIs. Endpoints and auth can change without notice.
