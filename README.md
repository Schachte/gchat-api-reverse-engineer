# Google Chat API (Unofficial)

## 1) What is this repo and why?

Google Chat doesn’t have an official API for personal/consumer accounts. This repo is a reverse‑engineered TypeScript/Node.js client that talks to the same internal endpoints the web app uses (`chat.google.com`) so you can automate your own Chat account locally.

## 2) Features

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

## 3) Setup

```bash
# repo deps (dev helpers)
npm install

# optional: local config
cp .env.example .env

# main package (library + CLI + server)
cd packages/gchat
npm install
npm run build
```

## 4) Running locally

### CLI

```bash
cd packages/gchat

# auth/cache status
npm start -- auth status

# list spaces
npm start -- spaces

# export last 7 days
npm start -- export AAAA_SPACE_ID --since 7d --full-threads
```

### API server + UI

```bash
# from repo root
npm run serve

# hot reload server
npm run dev
```

- UI: `http://localhost:3000/ui`
- API docs: `http://localhost:3000/docs`

### Docs + tests

```bash
# MkDocs site
npm run dev:docs

# Vitest
npm test
```

For deeper CLI docs see `packages/gchat/README.md`. For more docs see `documentation/`.

Disclaimer: this uses unofficial/internal Google APIs. Endpoints and auth can change without notice.
