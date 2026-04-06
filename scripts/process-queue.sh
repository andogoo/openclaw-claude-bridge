#!/usr/bin/env bash
# process-queue.sh — Обработва чакащи съобщения от message queue
# Извиква се от system crontab на всеки 2 минути
# 0 AI токена — чист bash

QUEUE_FILE="/tmp/darvin-message-queue.txt"
BRIDGE="$(dirname "$0")/claude-code-bridge.sh"
LOCK_FILE="/tmp/darvin-queue-processing.lock"

# Ако файлът не съществува или е празен — излез тихо
[ -s "$QUEUE_FILE" ] || exit 0

# Ако вече се обработва — излез (предотвратява race condition)
[ -f "$LOCK_FILE" ] && exit 0
touch "$LOCK_FILE"
trap 'rm -f "$LOCK_FILE"' EXIT

# Прочети и изтрий queue файла атомарно
QUEUE_CONTENT=$(cat "$QUEUE_FILE")
rm -f "$QUEUE_FILE"

# Обработи всяко съобщение
while IFS= read -r line; do
  [ -z "$line" ] && continue
  # Формат: timestamp|||message
  MSG="${line#*|||}"
  [ -z "$MSG" ] && continue
  # Прати на Claude Code bridge
  bash "$BRIDGE" "$MSG" &
  sleep 1  # Дай малко пространство между съобщения
done <<< "$QUEUE_CONTENT"

wait
