#!/bin/bash
set -euo pipefail

mkdir -p "$(dirname "$0")/../data"
cd "$(dirname "$0")/../data"

if [ -f cert.pem ] && [ -f key.pem ]; then
  echo "Certificates already exist in data/"
  exit 0
fi

# LAN IPs of this machine, so phones on the cabin Wi-Fi can open https://<ip>:3001
IPS=$( { ipconfig getifaddr en0 2>/dev/null; ipconfig getifaddr en1 2>/dev/null; hostname -I 2>/dev/null; } | tr " " "\n" | grep -E "^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$" | sort -u | tr "\n" " " || true)

if command -v mkcert >/dev/null 2>&1; then
  mkcert -install
  mkcert -cert-file cert.pem -key-file key.pem localhost 127.0.0.1 ::1 $IPS
  echo "Created trusted local certs with mkcert"
  exit 0
fi

openssl req -x509 -newkey rsa:2048 -sha256 -days 365 -nodes \
  -keyout key.pem \
  -out cert.pem \
  -subj "/CN=localhost" \
  -addext "subjectAltName=DNS:localhost,IP:127.0.0.1$(for ip in $IPS; do printf ',IP:%s' "$ip"; done)"
echo "Created self-signed certs with openssl"
echo "Safari/Chrome may warn until you trust data/cert.pem"
