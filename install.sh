#!/usr/bin/env bash
set -euo pipefail

# ── lossless-recall installer ────────────────────────────────────────────────
# Registers the MCP server and Stop hook with Claude Code.

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
DIST_DIR="$SCRIPT_DIR/dist"

echo "=== lossless-recall installer ==="
echo ""

# 1. Build if needed
if [ ! -f "$DIST_DIR/server.js" ]; then
  echo "[1/3] Building TypeScript..."
  cd "$SCRIPT_DIR"
  npm run build
else
  echo "[1/3] Build already exists, skipping (run 'npm run build' to rebuild)"
fi

# 2. Register MCP server
echo "[2/3] Registering MCP server with Claude Code..."
claude mcp add lossless-recall \
  --transport stdio \
  -- node "$DIST_DIR/server.js"

echo "  ✓ MCP server 'lossless-recall' registered"

# 3. Hook setup instructions
echo "[3/3] Hook setup"
echo ""
echo "  To capture conversations automatically, add a Stop hook to your"
echo "  Claude Code settings. Run this command:"
echo ""
echo "    claude config"
echo ""
echo "  Then add this to your settings.json under \"hooks\":"
echo ""
cat <<'HOOK'
    "hooks": {
      "Stop": [
        {
          "matcher": "",
          "hooks": [
            {
              "type": "command",
              "command": "node DIST_DIR/capture.js"
            }
          ]
        }
      ]
    }
HOOK
echo ""
echo "  Replace DIST_DIR with: $DIST_DIR"
echo ""
echo "=== Installation complete ==="
echo ""
echo "Tools available:"
echo "  • recall_grep     — Search all conversation history"
echo "  • recall_describe — Fetch full message content"
echo "  • recall_sessions — List recorded sessions"
echo ""
echo "Database location: ~/.claude/recall.db"
echo ""
echo "Test it: claude /mcp to verify the server is connected"
