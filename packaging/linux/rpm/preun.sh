#!/bin/sh
# indiansassist-agent %preun (Phase F contract section 8.9); $1 = 0 on erase, 1 on upgrade.
# On erase only: the signed deregister (D section 4.1), bounded to 10 s, whose exit status is
# ignored (an offline host, an unreachable api or an unenrolled device never fails an erase), then
# the unit is disabled and stopped when systemd is running. Nothing is downloaded and no home
# directory is touched.
if [ "$1" -eq 0 ]; then
  if [ -x /usr/lib/indiansassist/ia-service ]; then
    if command -v timeout >/dev/null 2>&1; then
      timeout -k 2 10 /usr/lib/indiansassist/ia-service --deregister || true
    else
      /usr/lib/indiansassist/ia-service --deregister || true
    fi
  fi
  if [ -d /run/systemd/system ]; then
    systemctl disable --now indiansassist-agent >/dev/null 2>&1 || true
  fi
fi
exit 0
