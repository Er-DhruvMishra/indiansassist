#!/bin/bash
# The finish script of every runit service: finish.sh <service> <exit-code> <signal>. runsv restarts a service that
# dies, so a single crash heals itself; a service that keeps dying is reported so the container exits non-zero instead
# of sitting half-alive.
set -u

STATE=${IA_STATE_DIR:-/run/ia/state}
LIMIT=${IA_FAILURE_LIMIT:-5}
WINDOW=${IA_FAILURE_WINDOW:-120}
service=${1:?usage: finish.sh <service> <exit-code> <signal>}

# A requested stop is not a failure.
if [ -e "$STATE/stopping" ]; then exit 0; fi

log_file="$STATE/$service.failures"
printf -v now '%(%s)T' -1
printf '%s\n' "$now" >> "$log_file"

mapfile -t failures < <(tail -n "$LIMIT" "$log_file")
printf '%s\n' "${failures[@]}" > "$log_file"

if [ "${#failures[@]}" -ge "$LIMIT" ] && [ $((now - failures[0])) -le "$WINDOW" ]; then
  printf '%s\n' "$service" > "$STATE/fatal"
  printf 'ia: service %s failed %s times in %ss; stopping the container\n' "$service" "$LIMIT" "$WINDOW" >&2
  # Wakes the entrypoint at once; it also polls, so a missing pipe costs at most a second.
  if [ -p "$STATE/wake" ]; then printf '.\n' > "$STATE/wake"; fi
fi
exit 0
