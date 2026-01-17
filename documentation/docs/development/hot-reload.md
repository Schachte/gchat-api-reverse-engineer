# Hot Reload

The project supports hot reload for rapid development. Changes to source files automatically trigger rebuilds and server restarts.

## Quick Reference

| Command | Description | Location |
|---------|-------------|----------|
| `npm run dev` | Server with hot reload | Root |
| `npm run dev:docs` | Docs with hot reload | Root |
| `npm run dev:all` | Both server + docs | Root |

## Server Hot Reload

### Start Development Server

```bash
# From project root
npm run dev

# Or from package directory
cd packages/gchat && npm run serve:watch
```

This uses [tsx](https://github.com/esbuild-kit/tsx) with watch mode to:

- Monitor all `.ts` files in `packages/gchat/src/`
- Automatically restart the server on changes
- Preserve terminal output (no screen clear)

### What Triggers a Reload

Any change to files in `packages/gchat/src/`:

- `*.ts` - TypeScript source files
- `*.json` - JSON configuration (if imported)

### Example Workflow

1. Start the dev server: `npm run dev`
2. Open `http://localhost:3000` in browser
3. Edit `packages/gchat/src/server/api-server.ts` or `packages/gchat/src/cli/program.ts`
4. Server automatically restarts
5. Refresh browser to see changes

!!! tip "WebSocket Reconnection"
    The web UI automatically attempts to reconnect WebSocket connections when the server restarts.

## Documentation Hot Reload

### Start Documentation Server

```bash
# From project root
npm run dev:docs

# Or directly
cd documentation && ./serve.sh
```

MkDocs provides built-in hot reload:

- Monitors all `.md` files in `documentation/docs/`
- Automatically rebuilds on changes
- Browser auto-refreshes via LiveReload

### What Triggers a Reload

- `*.md` - Markdown documentation files
- `mkdocs.yml` - Configuration changes

### Default Ports

| Service | URL |
|---------|-----|
| Documentation | `http://localhost:8000` |

## Running Everything Together

### Combined Development Mode

```bash
npm run dev:all
```

This uses [concurrently](https://github.com/open-cli-tools/concurrently) to run both services:

- **Server** - Blue label `[server]`
- **Docs** - Green label `[docs]`

Example output:

```
[server] Server running at http://localhost:3000
[server] WebSocket server ready
[docs] INFO - Building documentation...
[docs] INFO - Serving on http://127.0.0.1:8000
```

### Stopping Services

Press `Ctrl+C` to stop all services at once.

## Available Scripts Reference

### Root Directory (`/google-chat-api`)

| Script | Command | Description |
|--------|---------|-------------|
| `dev` | `npm run dev` | Start server with hot reload |
| `dev:server` | `npm run dev:server` | Alias for `dev` |
| `dev:docs` | `npm run dev:docs` | Start docs with hot reload |
| `dev:all` | `npm run dev:all` | Start server + docs together |
| `build` | `npm run build` | Build production client |
| `serve` | `npm run serve` | Start production server |
| `test` | `npm test` | Run client unit tests |

### Package Directory (`/google-chat-api/packages/gchat`)

| Script | Command | Description |
|--------|---------|-------------|
| `dev` | `npm run dev` | Run CLI from source (tsx) |
| `dev:watch` | `npm run dev:watch` | Run CLI from source (watch) |
| `start` | `npm start -- <cmd>` | Run built CLI (`dist/cli.js`) |
| `serve` | `npm run serve` | Start production API server (`gchat api`) |
| `serve:watch` | `npm run serve:watch` | API server with hot reload |
| `build` | `npm run build` | Compile TypeScript |
| `build:watch` | `npm run build:watch` | Watch mode compilation |
| `test` | `npm test` | Run unit tests |
| `test:watch` | `npm run test:watch` | Watch tests |

## Troubleshooting

### Server Not Restarting

If the server doesn't restart on file changes:

1. Check that you're editing files in `packages/gchat/src/`
2. Ensure tsx is installed: `cd packages/gchat && npm install`
3. Try restarting the dev command

### Port Already in Use

If port 3000 is already in use:

```bash
# Find process using port 3000
lsof -i :3000

# Kill it
kill -9 <PID>
```

### Documentation Not Updating

If docs don't update:

1. Check that you're editing files in `documentation/docs/`
2. Ensure Python venv is set up: `cd documentation && ./serve.sh`
3. Check for syntax errors in markdown

### WebSocket Disconnections

The web UI shows "Disconnected" when:

- Server is restarting (normal during hot reload)
- Network issues

The UI will automatically reconnect when the server is back up.
