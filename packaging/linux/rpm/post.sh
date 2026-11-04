#!/bin/sh
# indiansassist-agent %post (Phase F contract section 8.9); $1 = 1 on install, 2 on upgrade.
# The systemd steps run only when systemd is the running init (/run/systemd/system exists), so the
# package also installs in a container or chroot without systemd. Nothing is downloaded and no home
# directory is touched. (The restart onto new binaries after an upgrade is in %postun.)
if [ -d /run/systemd/system ]; then
  systemctl daemon-reload >/dev/null 2>&1 || true
  systemctl enable --now indiansassist-agent || \
    echo "indiansassist-agent: the service could not be started; see: journalctl -u indiansassist-agent" >&2
else
  echo "indiansassist-agent: systemd is not running here; the service was installed but not started."
fi
exit 0
