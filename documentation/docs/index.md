# Google Chat API Documentation

An unofficial TypeScript/Node.js client + CLI for Google Chat that uses reverse-engineered internal endpoints.

## Why This Project Exists

Google Chat has **no official API for personal accounts**. The official Google Chat API requires a Google Workspace account and is designed for bots only. This project reverse-engineers the internal API used by `chat.google.com` to provide programmatic access for personal accounts.

## Features

- **Full-featured CLI** (`gchat`) for command-line access to spaces, messages, notifications, export, and presence tooling
- **Cookie-based authentication** (extracts cookies from a logged-in browser profile + XSRF bootstrap)
- **RESTful HTTP API server** with Scalar API documentation and web interface
- **TypeScript library** for programmatic Node.js usage
- **Logging** with configurable log levels for debugging
- **Cursor-based batching** for exporting large spaces

## Quick Start

### Installation

```bash
# Clone and install
git clone <repo-url>
cd google-chat-api

# Install dependencies
npm install
cd packages/gchat && npm install && npm run build
```

### Start the Web UI & API Server

```bash
# Production mode
npm run serve

# Development mode (hot reload)
npm run dev
```

Open `http://localhost:3000` in your browser.

### CLI Usage

```bash
cd packages/gchat

# List your spaces
npm start -- spaces

# Check notifications and mentions
npm start -- notifications --me

# Get messages from a space
npm start -- messages SPACE_ID

# Send a message
npm start -- send SPACE_ID "Hello!"
```

## Documentation Sections

| Section | Description |
|---------|-------------|
| [Development](development/index.md) | Getting started, hot reload, contributing |
| [CLI](cli/index.md) | Command-line interface usage and commands |
| [API Reference](api/index.md) | HTTP server endpoints and programmatic usage |
| [Authentication](authentication/index.md) | Cookie-based auth and cache behavior |
| [Architecture](architecture/index.md) | System design and component overview |
| [Terminology](terminology.md) | Key terms like Dynamite, PBLite, XSRF Token |
| [Reverse Engineering](reverse-engineering/index.md) | How the API was decoded |

## Disclaimer

!!! warning "Unofficial API"
    This is a **reverse-engineered unofficial API**. Endpoints and authentication methods may change without notice as Google updates their internal systems. Use at your own risk.

    This project is not affiliated with, endorsed by, or connected to Google in any way.

## Credits

Based on the authentication flow from [purple-googlechat](https://github.com/EionRobb/purple-googlechat), a Pidgin plugin for Google Chat.
