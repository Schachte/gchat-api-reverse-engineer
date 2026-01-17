# Development Guide

This guide covers setting up a development environment for contributing to the Google Chat API project.

## Prerequisites

- **Node.js** >= 18.0.0
- **npm** >= 8.0.0
- **Python 3** (for documentation only)

## Project Structure

```
google-chat-api/
├── packages/
│   └── gchat/           # TypeScript library + CLI + API server
│       ├── src/         # Source code
│       ├── dist/        # Compiled output
│       ├── public/      # Web UI assets
│       └── package.json # Package dependencies
├── documentation/       # MkDocs documentation
│   ├── docs/            # Markdown files
│   ├── mkdocs.yml       # MkDocs configuration
│   └── serve.sh         # Documentation server script
└── package.json         # Root scripts for development
```

## Quick Start

### 1. Install Dependencies

```bash
# Install root dependencies (concurrently for running multiple services)
npm install

# Install client dependencies
cd packages/gchat && npm install
```

### 2. Start Development Server

```bash
# From root directory - starts server with hot reload
npm run dev
```

The server will start at `http://localhost:3000` and automatically restart when you modify any `.ts` file in `packages/gchat/src/`.

### 3. Start Documentation Server (Optional)

```bash
# From root directory
npm run dev:docs
```

Documentation will be available at `http://localhost:8000` with live reload on markdown changes.

### 4. Run Everything Together

```bash
# Starts both server and docs with colored output
npm run dev:all
```

## Available Scripts

See [Hot Reload](hot-reload.md) for detailed information about all available development commands.

## Making Changes

### Client/Server Changes

1. Edit files in `packages/gchat/src/`
2. Server automatically restarts (if using `npm run dev`)
3. Refresh browser to see changes

### Documentation Changes

1. Edit files in `documentation/docs/`
2. MkDocs automatically rebuilds (if using `npm run dev:docs`)
3. Browser auto-refreshes

## Building for Production

```bash
# Build the client
npm run build

# Or from package directory
cd packages/gchat && npm run build
```

## Next Steps

- [Hot Reload](hot-reload.md) - Detailed hot reload configuration
- [Repository Layout](../architecture/repository-layout.md) - Detailed file structure
- [CLI Commands](../cli/commands.md) - Available CLI commands
