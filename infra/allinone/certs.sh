#!/bin/bash
# certs.sh copy    copies the TLS pair from /data/certs to where coturn may read it (entrypoint, every start)
# certs.sh reload  the same, then makes nginx and coturn use the new pair (a renewal hook runs this with `docker exec`)
#
# A mounted key is often readable by root only, and coturn is not root, so coturn gets its own copy under /run.
set -Eeuo pipefail

SRC=/data/certs
DST=/run/ia/coturn-certs

copy() {
  rm -f "$DST/fullchain.pem" "$DST/privkey.pem"
  if [ -s "$SRC/fullchain.pem" ] && [ -s "$SRC/privkey.pem" ]; then
    install -o root -g turnserver -m 640 "$SRC/fullchain.pem" "$DST/fullchain.pem"
    install -o root -g turnserver -m 640 "$SRC/privkey.pem" "$DST/privkey.pem"
  fi
}

case "${1:-}" in
  copy) copy ;;
  reload)
    copy
    nginx -s reload
    sv restart /ia/sv/coturn
    ;;
  *)
    echo "usage: certs.sh copy|reload" >&2
    exit 2
    ;;
esac
