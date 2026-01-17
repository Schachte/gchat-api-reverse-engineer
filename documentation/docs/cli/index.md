# CLI Overview

The Google Chat CLI (`gchat`) provides command-line access to Google Chat for personal accounts. It uses cookie-based authentication extracted from your Chrome browser.

## Installation

```bash
cd packages/gchat
npm install
npm run build

# Optional: install `gchat` on your PATH for local development
npm link
```

## Quick Start

```bash
# Check auth/cache status
gchat auth status

# List available browsers / profiles
gchat auth browsers
gchat auth profiles

# List all spaces
gchat spaces

# Get messages from a space
gchat messages SPACE_ID

# Export the last 7 days (batched + resumable)
gchat export SPACE_ID --since 7d --full-threads

# Send a message
gchat send SPACE_ID "Hello, world!"

# Start the API server with web UI
gchat api
```

## Global Options

These options work with all commands:

| Option | Description |
|--------|-------------|
| `--no-color` | Disable colored output |
| `-b, --browser <type>` | Browser to use for cookie extraction |
| `-p, --profile <name>` | Chrome profile to use for cookie extraction |
| `--cookie-path <path>` | Custom cookie database file path |
| `--cache-dir <path>` | Cache directory for auth state (default: `~/.gchat` or `GCHAT_CACHE_DIR`) |
| `--refresh` | Force re-authentication (re-extract cookies) |
| `--json` | Output results as JSON |
| `--debug` | Enable debug logging |
| `--log-level <level>` | Set log level: `error`, `warn`, `info`, `debug`, `silent` |
| `-h, --help` | Display help information |

## Environment (`.env`)

For local development, the CLI loads environment variables from a `.env` file if present:

- `.env` in the current working directory
- `.env` in the parent directory (useful when running via repo root scripts)

To force a specific env file, set:

```bash
GCHAT_ENV_FILE=/path/to/.env gchat spaces
```

## Authentication

The CLI automatically extracts cookies from your Chrome browser. On first run, it will:

1. Detect available Chrome profiles
2. Extract authentication cookies from the selected profile
3. Cache the authentication for subsequent runs (in `--cache-dir`)

To use a specific Chrome profile:

```bash
gchat --profile "Profile 1" spaces
```

To force re-authentication:

```bash
gchat --refresh spaces
```

## Output Formats

### Human-Readable (Default)

```bash
gchat spaces
```

Output includes colored formatting, headers, and organized sections.

### JSON Output

```bash
gchat --json spaces
```

Outputs raw JSON for scripting and automation:

```json
[
  {
    "id": "AAAA_abc123",
    "name": "Team Chat",
    "type": "space"
  }
]
```

## Common Workflows

### Check Unread Notifications

```bash
# See all unread items (mentions, threads, DMs)
gchat notifications

# Only direct @mentions to you
gchat notifications --me

# Only DM notifications
gchat notifications --dms
```

### Read Messages from a Space

```bash
# Find a space by name
gchat find-space "project"

# Get messages from that space
gchat messages SPACE_ID

# Get threaded messages with pagination
gchat threads SPACE_ID --pages 3
```

### Export History

```bash
# Full export (batched)
gchat export SPACE_ID --full-threads

# Export a date range
gchat export SPACE_ID --since 2024-01-01 --until 2024-06-30

# Resume an interrupted export (reuses cursors stored in output file)
gchat export SPACE_ID -o export-SPACE_ID-2024-01-01.json
```

### Stay Online (Presence)

```bash
# Keep your presence online via WebChannel (lightweight, no browser)
gchat stay-online --subscribe --ping-interval 60 --presence-timeout 120

# Keep your presence online via browser automation (Playwright)
# First run: opens browser for manual login, saves session
gchat presence --no-headless
# After login saved: runs headless automatically
gchat presence
```

### Send Messages

```bash
# Start a new thread
gchat send SPACE_ID "Hello everyone!"

# Reply to an existing thread
gchat reply SPACE_ID TOPIC_ID "Thanks for the update!"
```

### Search

```bash
# Search across all spaces
gchat search "quarterly report"

# Search within a specific space
gchat search "budget" --space SPACE_ID
```

## Next Steps

- [Commands Reference](commands.md) - Full documentation of all commands
- [Logging & Debugging](logging.md) - Debug output and troubleshooting
- [API Server](../api/index.md) - HTTP API and web interface
