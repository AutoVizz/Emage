#!/bin/sh
# The official nginx entrypoint sources executable .sh files before starting nginx.
set -eu
mkdir -p /etc/nginx/emage-tls
cert=/etc/letsencrypt/live/emage/fullchain.pem
key=/etc/letsencrypt/live/emage/privkey.pem
configure_tls() {
    cat > /etc/nginx/emage-tls/listen.conf <<TLS
listen 443 ssl;
ssl_certificate $cert;
ssl_certificate_key $key;
ssl_protocols TLSv1.2 TLSv1.3;
TLS
}
if [ -s "$cert" ] && [ -s "$key" ]; then configure_tls; fi
(
    previous=$(readlink -f "$cert" 2>/dev/null || true)
    while sleep 30; do
        current=$(readlink -f "$cert" 2>/dev/null || true)
        if [ -s "$cert" ] && [ -s "$key" ] && [ "$current" != "$previous" ]; then
            configure_tls
            if nginx -t && nginx -s reload; then previous=$current; fi
        fi
    done
) &
