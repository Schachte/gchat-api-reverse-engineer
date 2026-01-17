#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
VENV_DIR="$SCRIPT_DIR/venv"

# Create virtual environment if it doesn't exist
if [ ! -d "$VENV_DIR" ]; then
    echo "Creating virtual environment..."
    python3 -m venv "$VENV_DIR"
fi

# Install dependencies if needed
if [ ! -f "$VENV_DIR/.installed" ]; then
    echo "Installing dependencies..."
    "$VENV_DIR/bin/pip" install -q -r "$SCRIPT_DIR/requirements.txt"
    touch "$VENV_DIR/.installed"
fi

# Run mkdocs serve
echo "Starting MkDocs server..."
"$VENV_DIR/bin/mkdocs" serve -f "$SCRIPT_DIR/mkdocs.yml"
