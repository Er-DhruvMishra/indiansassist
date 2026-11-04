#!/bin/sh
# Phase F section 17.3: remove the IndiansAssist agent from this Mac. Installed at
# /Library/IndiansAssist/uninstall.sh; run it as root:
#
#   sudo /Library/IndiansAssist/uninstall.sh
#
# In order: stop the worker in every open GUI session and the daemon; the signed deregister (bounded to 10 s;
# an offline Mac still uninstalls) and the keys shredded from the System keychain; then the files, the jobs,
# the state, the logs and the package receipt. Never fails half way on a missing piece.
PATH=/usr/bin:/bin:/usr/sbin:/sbin
if [ "$(id -u)" -ne 0 ]; then
    echo "run it as root: sudo $0" >&2
    exit 1
fi
for uid in $(ps -axo uid=,comm= | awk '$2 ~ /loginwindow$/ {print $1}' | sort -u); do
    [ "$uid" -gt 0 ] 2>/dev/null || continue
    launchctl bootout "gui/$uid/com.indiansassist.desktop" 2>/dev/null || true
done
launchctl bootout system/com.indiansassist.agent 2>/dev/null || true
[ -x /Library/IndiansAssist/ia-service ] && /Library/IndiansAssist/ia-service --deregister || true
rm -f /Library/LaunchDaemons/com.indiansassist.agent.plist /Library/LaunchAgents/com.indiansassist.desktop.plist
rm -rf "/Library/IndiansAssist" "/Library/Application Support/IndiansAssist" /Library/Logs/IndiansAssist \
    /var/run/indiansassist
pkgutil --forget com.indiansassist.agent.pkg >/dev/null 2>&1 || true
echo "IndiansAssist was removed."
exit 0
