#!/usr/bin/env bash
# Paper Agent 启动器：确保 Overleaf 与 server 在跑，然后开一个独立应用窗口
set -e
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# 1. Overleaf 容器
if ! docker ps --format '{{.Names}}' | grep -q '^sharelatex$'; then
  echo "启动 Overleaf 容器..."
  (cd "$DIR/../overleaf-toolkit" && bin/up -d)
fi

# 2. Paper Agent server
if ! curl -sf -o /dev/null http://127.0.0.1:8080/__agent/; then
  echo "启动 Paper Agent server..."
  nohup node "$DIR/server.js" >> "$DIR/server.log" 2>&1 &
  for i in $(seq 1 20); do
    curl -sf -o /dev/null http://127.0.0.1:8080/__agent/ && break
    sleep 0.5
  done
fi

# 3. 应用窗口
exec google-chrome-stable --app=http://localhost:8080/__agent/ \
  --user-data-dir="$HOME/.config/paper-agent-chrome" "$@"
