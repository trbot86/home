#!/bin/sh
set -eu
if [ -n "${CAPTURE_SOCKET:-}" ]; then
  case "$CAPTURE_SOCKET" in /*) ;; *) echo 'Capture socket must be absolute' >&2; exit 1 ;; esac
  umask 077
  lock="$CAPTURE_SOCKET.lock"
  if [ -L "$lock" ] || { [ -e "$lock" ] && [ ! -f "$lock" ]; }; then
    echo 'Invalid capture socket lock' >&2
    exit 1
  fi
  exec 9>>"$lock"
  flock --exclusive --nonblock 9
  export CAPTURE_SOCKET_LOCK_HELD=1
fi
if [ "$#" -eq 0 ]; then
  base=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
  set -- node "$base/dist/capture-main.js"
fi
exec "$@"
