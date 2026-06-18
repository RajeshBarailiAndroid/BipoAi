#!/usr/bin/env bash
# Generate a self-signed certificate for local HTTPS (dev / same-WiFi testing).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CERT_DIR="$ROOT/certs"
mkdir -p "$CERT_DIR"

IP="${1:-$(ipconfig getifaddr en0 2>/dev/null || echo 127.0.0.1)}"

openssl req -x509 -newkey rsa:2048 -nodes \
  -keyout "$CERT_DIR/localhost-key.pem" \
  -out "$CERT_DIR/localhost.pem" \
  -days 365 \
  -subj "/CN=localhost" \
  -addext "subjectAltName=DNS:localhost,IP:127.0.0.1,IP:${IP}"

echo ""
echo "Created:"
echo "  $CERT_DIR/localhost-key.pem"
echo "  $CERT_DIR/localhost.pem"
echo ""
echo "Start with HTTPS:"
echo "  HTTPS=true npm start"
echo ""
echo "On your phone (same Wi-Fi), open:"
echo "  https://${IP}:3001"
echo ""
echo "Your browser will warn about the certificate — that is normal for local dev."
echo "Tap Advanced → Proceed to continue."
