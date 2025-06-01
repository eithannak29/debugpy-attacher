#!/usr/bin/env bash

declare -A pid_cmd
declare -A pid_start
declare -A seen

# Get all Python processes
while IFS= read -r line; do
  pid=$(echo "$line" | awk '{print $1}')
  start=$(echo "$line" | awk '{print $2}')
  cmd=$(echo "$line" | cut -d' ' -f3-)
  pid_cmd["$pid"]="$cmd"
  pid_start["$pid"]="$start"
done < <(ps -eo pid,etime,args | grep python | grep -v grep)

# Filter debugpy ports
lsof -nP -iTCP -sTCP:LISTEN | grep python | while read -r line; do
  pid=$(echo "$line" | awk '{print $2}')
  cmd=${pid_cmd["$pid"]}
  start=${pid_start["$pid"]}

  if [[ "$cmd" == *debugpy* ]]; then
    dbg_port=$(echo "$cmd" | grep -oE -- '--port [0-9]+' | awk '{print $2}')
    if [[ -n "$dbg_port" && -z "${seen[$dbg_port]}" ]]; then
      seen[$dbg_port]=1
      echo "🐞 debugpy → Port $dbg_port — PID $pid — ⏱️ $start — $cmd"
    fi
  fi
done
