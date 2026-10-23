#!/bin/sh
# Runs from the nginx image's /docker-entrypoint.d/ before nginx starts.
# If no certificate is mounted at /etc/nginx/certs, generate a short-lived self-signed one so the stack boots
# for a first local test. NEVER rely on it in production: mount a Let's Encrypt or customer certificate
# (infra/README.md, "TLS termination").
set -eu
CERT_DIR=/etc/nginx/certs
if [ -s "$CERT_DIR/fullchain.pem" ] && [ -s "$CERT_DIR/privkey.pem" ]; then
  exit 0
fi
CN="${IA_TLS_SELF_SIGNED_CN:-localhost}"
echo "ia: no certificate in $CERT_DIR, generating a self-signed one for CN=$CN (development only)" >&2
mkdir -p "$CERT_DIR"
openssl req -x509 -newkey rsa:2048 -nodes -days 30 \
  -subj "/CN=$CN" -addext "subjectAltName=DNS:$CN,DNS:localhost,IP:127.0.0.1" \
  -keyout "$CERT_DIR/privkey.pem" -out "$CERT_DIR/fullchain.pem" 2>/dev/null
# coturn (user nobody) reads the same pair for turns:5349; a dev-only self-signed key is made world readable.
chmod 644 "$CERT_DIR/fullchain.pem" "$CERT_DIR/privkey.pem"
