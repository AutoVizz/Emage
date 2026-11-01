#!/bin/sh
set -eu
python3 /usr/local/bin/client_auth.py &
python3 - <<'READY'
import time
from urllib.request import urlopen
for attempt in range(50):
    try:
        urlopen('http://127.0.0.1:8083/ready', timeout=1).close()
        break
    except OSError:
        time.sleep(.1)
else:
    raise SystemExit('Client login service did not start.')
READY
if [ -n "${EMAGE_CLIENT_PASSWORD:-}" ]; then
    printf '%s\n' 'auth_request /_client_auth;' > /etc/nginx/client-auth.conf
else
    printf '%s\n' 'auth_request off;' > /etc/nginx/client-auth.conf
fi
unset EMAGE_CLIENT_PASSWORD
