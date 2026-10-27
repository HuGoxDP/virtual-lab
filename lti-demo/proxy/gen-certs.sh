#!/bin/sh
# Runs inside the `certs` one-shot service (alpine/openssl). Idempotent: if the leaf
# certificate already exists nothing is regenerated, so the CA a browser already trusts stays valid.
set -eu
cd /certs
if [ -f server.crt ] && [ -f server.key ] && [ -f ca.crt ] && [ -f bundle.crt ]; then
  echo "certs: already present, keeping them"; exit 0
fi
echo "certs: generating local CA and a leaf for moodle.lti.test / lab.lti.test"
openssl req -x509 -newkey rsa:3072 -nodes -days 3650 -sha256 \
  -keyout ca.key -out ca.crt -subj "/CN=WebEngine LTI demo local CA/O=virtual-lab lti-demo" \
  -addext "basicConstraints=critical,CA:TRUE" -addext "keyUsage=critical,keyCertSign,cRLSign"
openssl req -newkey rsa:2048 -nodes -keyout server.key -out server.csr -subj "/CN=lab.lti.test"
cat > ext.cnf <<EXT
basicConstraints=CA:FALSE
keyUsage=critical,digitalSignature,keyEncipherment
extendedKeyUsage=serverAuth
subjectAltName=DNS:moodle.lti.test,DNS:lab.lti.test,DNS:localhost,IP:127.0.0.1
EXT
openssl x509 -req -in server.csr -CA ca.crt -CAkey ca.key -CAcreateserial -out server.crt \
  -days 825 -sha256 -extfile ext.cnf
rm -f server.csr ext.cnf ca.srl
# System roots + our CA: PHP's curl.cainfo in the Moodle container (Moodle fetches the tool's
# JWKS and calls its services over https://lab.lti.test with this).
cat /etc/ssl/certs/ca-certificates.crt ca.crt > bundle.crt
chmod 644 ca.crt server.crt server.key bundle.crt
echo "certs: done"
