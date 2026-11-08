#!/bin/bash
# Sourced by the image's scripts.

log() { printf 'ia: %s\n' "$*" >&2; }

# Replaces the calling (sub)shell with the command, running as that user with no capabilities left. Secrets reach the
# command only through the variables the caller exported, never through argv.
as_user() {
  local user=$1
  shift
  export HOME=/tmp
  exec setpriv --reuid="$user" --regid="$(id -g "$user")" --init-groups --inh-caps=-all --bounding-set=-all -- "$@"
}

# load <name>: exports the variables of one per-service file. Those files are root-only and every caller is still root,
# so a service never holds another service's credential, nor a file it could re-read.
load_env() {
  # shellcheck disable=SC1090
  . "/run/ia/env/$1.env"
}

# retry <seconds> <command...>: runs the command every half second until it succeeds or time runs out.
retry() {
  local remaining=$(($1 * 2))
  shift
  until "$@" >/dev/null 2>&1; do
    remaining=$((remaining - 1))
    if [ "$remaining" -le 0 ]; then return 1; fi
    sleep 0.5
  done
}
