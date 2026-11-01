#!/bin/sh
set -eu
if [ -n "${EMAGE_CLIENT_PASSWORD:-}" ]; then
    umask 077
    printf '%s\n' "$EMAGE_CLIENT_PASSWORD" | htpasswd -iBc /etc/nginx/client.htpasswd emage
    chown root:nginx /etc/nginx/client.htpasswd
    chmod 640 /etc/nginx/client.htpasswd
    cat > /etc/nginx/client-auth.conf <<'CONF'
auth_basic "Emage";
auth_basic_user_file /etc/nginx/client.htpasswd;
CONF
else
    printf '%s\n' 'auth_basic off;' > /etc/nginx/client-auth.conf
    rm -f /etc/nginx/client.htpasswd
fi
unset EMAGE_CLIENT_PASSWORD
