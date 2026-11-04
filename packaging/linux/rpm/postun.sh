#!/bin/sh
# indiansassist-agent %postun (Phase F contract section 8.9); $1 = 0 on erase, 1 on upgrade.
# On erase: remove the state (/var/lib/indiansassist) and the config drop (/etc/indiansassist), and
# the runtime directory if one was left behind. On upgrade: restart a running service onto the new
# binaries (so its section 8.8 integrity check does not compare an old image with new files).
# systemd steps only when systemd is running. Nothing is downloaded and no home directory is touched.
if [ "$1" -eq 0 ]; then
  rm -rf /var/lib/indiansassist /etc/indiansassist /run/indiansassist
fi
if [ -d /run/systemd/system ]; then
  systemctl daemon-reload >/dev/null 2>&1 || true
  if [ "$1" -ge 1 ]; then
    systemctl try-restart indiansassist-agent >/dev/null 2>&1 || true
  fi
fi
exit 0
