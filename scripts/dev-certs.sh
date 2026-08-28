#!/usr/bin/env bash
# Generates a local development CA and the two leaf certificates the
# gateway's mTLS caller-auth mode (Task 15) needs in compose:
#   certs/ca.pem                — the CA every leaf is signed by
#   certs/gateway.{pem,key}     — the gateway's server certificate
#                                 (CN gateway, SAN DNS:gateway,DNS:localhost)
#   certs/api.{pem,key}         — the client certificate apps/api presents
#                                 (CN lexprompt-api)
#
# `certs/` is gitignored (see .gitignore) — nothing this script writes may
# ever be committed. A private key committed to this repo is the one
# mistake in Task 15 that a later commit cannot undo.
#
# Idempotent: if every file this script produces already exists, it prints
# where they are and exits without touching them. Pass --force to
# regenerate (e.g. after the CN or SAN list below changes).

set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

# On Git Bash / MSYS (Windows), the runtime rewrites any argument that looks
# like a POSIX absolute path — including openssl's `/CN=...` subject
# strings — into a Windows path, which breaks `-subj`. This opts out; it is
# a no-op on real Linux/macOS bash.
export MSYS_NO_PATHCONV=1

CERTS_DIR="certs"
FORCE=false
for arg in "$@"; do
  case "$arg" in
    --force) FORCE=true ;;
  esac
done

mkdir -p "$CERTS_DIR"

CA_KEY="$CERTS_DIR/ca.key"
CA_PEM="$CERTS_DIR/ca.pem"
GATEWAY_KEY="$CERTS_DIR/gateway.key"
GATEWAY_PEM="$CERTS_DIR/gateway.pem"
API_KEY="$CERTS_DIR/api.key"
API_PEM="$CERTS_DIR/api.pem"

all_exist() {
  [ -f "$CA_PEM" ] && [ -f "$GATEWAY_PEM" ] && [ -f "$GATEWAY_KEY" ] \
    && [ -f "$API_PEM" ] && [ -f "$API_KEY" ]
}

if all_exist && [ "$FORCE" = false ]; then
  echo "Dev certificates already exist in $CERTS_DIR/ — pass --force to regenerate."
else
  echo "Generating a local development CA and leaf certificates in $CERTS_DIR/ ..."

  # --- CA -------------------------------------------------------------
  openssl req -x509 -newkey rsa:2048 -sha256 -days 825 -nodes \
    -keyout "$CA_KEY" -out "$CA_PEM" \
    -subj "/CN=lexprompt-dev-ca"

  # --- gateway server certificate --------------------------------------
  GATEWAY_CSR="$CERTS_DIR/gateway.csr"
  GATEWAY_EXT="$CERTS_DIR/gateway.ext"
  openssl req -newkey rsa:2048 -nodes \
    -keyout "$GATEWAY_KEY" -out "$GATEWAY_CSR" \
    -subj "/CN=gateway"
  cat > "$GATEWAY_EXT" <<EOF
subjectAltName = DNS:gateway,DNS:localhost
extendedKeyUsage = serverAuth
EOF
  openssl x509 -req -in "$GATEWAY_CSR" -CA "$CA_PEM" -CAkey "$CA_KEY" \
    -CAcreateserial -days 825 -sha256 -out "$GATEWAY_PEM" \
    -extfile "$GATEWAY_EXT"
  rm -f "$GATEWAY_CSR" "$GATEWAY_EXT"

  # --- api client certificate -------------------------------------------
  API_CSR="$CERTS_DIR/api.csr"
  API_EXT="$CERTS_DIR/api.ext"
  openssl req -newkey rsa:2048 -nodes \
    -keyout "$API_KEY" -out "$API_CSR" \
    -subj "/CN=lexprompt-api"
  cat > "$API_EXT" <<EOF
extendedKeyUsage = clientAuth
EOF
  openssl x509 -req -in "$API_CSR" -CA "$CA_PEM" -CAkey "$CA_KEY" \
    -CAcreateserial -days 825 -sha256 -out "$API_PEM" \
    -extfile "$API_EXT"
  rm -f "$API_CSR" "$API_EXT" "$CERTS_DIR"/*.srl

  echo "Done."
fi

cat <<EOF

Files:
  $CA_PEM
  $GATEWAY_PEM
  $GATEWAY_KEY
  $API_PEM
  $API_KEY

Paste into .env for the gateway (mTLS mode):
  GATEWAY_CALLER_AUTH=mtls
  GATEWAY_MTLS_CA_FILE=$CA_PEM
  GATEWAY_MTLS_CERT_FILE=$GATEWAY_PEM
  GATEWAY_MTLS_KEY_FILE=$GATEWAY_KEY
  GATEWAY_MTLS_ALLOWED_SUBJECT=lexprompt-api

Paste into .env for apps/api (the caller):
  API_MTLS_CA_FILE=$CA_PEM
  API_MTLS_CERT_FILE=$API_PEM
  API_MTLS_KEY_FILE=$API_KEY
EOF
