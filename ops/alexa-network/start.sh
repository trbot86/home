#!/bin/sh
set -eu
node /guard/guard.mjs
# This exec replaces PID 1. No privileged shell or init process remains.
exec setpriv --reuid=1000 --regid=1000 --clear-groups --bounding-set=-all --inh-caps=-all --ambient-caps=-all --no-new-privs node /guard/hold.mjs
