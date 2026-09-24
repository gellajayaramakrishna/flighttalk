#!/bin/bash
set -euo pipefail

mkdir -p data
cd data

if [ -f cert.pem ] && [ -f key.pem ]; then
  echo "Certificates already exist in data/"
  exit 0
fi

if command -v mkcert >/dev/null 2>&1; then
  mkcert -install
  mkcert -cert-file cert.pem -key-file key.pem localhost 127.0.0.1 ::1
  echo "Created trusted local certs with mkcert"
  exit 0
fi

openssl req -x509 -newkey rsa:2048 -sha256 -days 365 -nodes \
  -keyout key.pem \
  -out cert.pem \
  -subj "/CN=localhost" \
  -addext "subjectAltName=DNS:localhost,IP:127.0.0.1"
echo "Created self-signed certs with openssl"
echo "Safari/Chrome may warn until you trust data/cert.pem"
