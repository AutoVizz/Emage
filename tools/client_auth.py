#!/usr/bin/env python3
"""Private password-only session gate for the static client."""
from collections import deque
from http.cookies import CookieError, SimpleCookie
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import hashlib
import hmac
import html
import os
import secrets
import threading
import time
from urllib.parse import parse_qs, urlsplit

COOKIE = 'emage_client_session'
SESSION_SECONDS = 12 * 60 * 60


def local_path(value):
    if not value.startswith('/') or value.startswith('//') or ('\\' in value or any(ord(c) < 32 or ord(c) == 127 for c in value)):
        return '/'
    return value if urlsplit(value).path != '/login' else '/'


class Sessions:
    def __init__(self, password):
        self.password = password
        self.key = secrets.token_bytes(32)
        self.failures = deque()
        self.lock = threading.Lock()

    def authenticate(self, password):
        with self.lock:
            now = time.monotonic()
            while self.failures and now - self.failures[0] >= 60:
                self.failures.popleft()
            if len(self.failures) >= 10:
                return 429
            if not hmac.compare_digest(password.encode(), self.password.encode()):
                self.failures.append(now)
                return 401
            return 200

    def issue(self):
        body = f'{int(time.time()) + SESSION_SECONDS}.{secrets.token_hex(16)}'
        signature = hmac.new(self.key, body.encode(), hashlib.sha256).hexdigest()
        return body + '.' + signature

    def valid(self, header):
        if not self.password:
            return True
        try:
            cookies = SimpleCookie(header)
            token = cookies[COOKIE].value
            expiry, nonce, signature = token.split('.')
            body = expiry + '.' + nonce
            expected = hmac.new(self.key, body.encode(), hashlib.sha256).hexdigest()
            return int(expiry) > time.time() and hmac.compare_digest(signature, expected)
        except (ValueError, KeyError, CookieError):
            return False


class LoginHandler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass  # Never log submitted passwords or session cookies.

    def respond(self, status, body=b'', headers=()):
        self.send_response(status)
        self.send_header('Content-Type', 'text/html; charset=utf-8')
        self.send_header('Cache-Control', 'no-store')
        self.send_header('Content-Length', str(len(body)))
        for key, value in headers:
            self.send_header(key, value)
        self.end_headers()
        self.wfile.write(body)

    def page(self, status=200, message='', destination='/'):
        body = f'''<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Enter Emage</title>
<style>:root{{color-scheme:light dark}}body{{font:16px system-ui;margin:0;min-height:100vh;display:grid;place-items:center;background:light-dark(#f8f7f4,#171819);color:light-dark(#222,#eee)}}main{{width:min(340px,80vw)}}h1{{font-size:2rem}}input,button{{font:inherit;box-sizing:border-box;width:100%;padding:.8rem;margin-top:1rem;border:1px solid #888;border-radius:6px}}button{{cursor:pointer}}p{{line-height:1.5}}[role=alert]{{color:light-dark(#a12424,#ffb0b0)}}</style></head>
<body><main><h1>Emage</h1><p>Enter the site password to continue.</p>
<form method="post" action="/login"><label for="password">Password</label><input id="password" name="password" type="password" autocomplete="current-password" required autofocus><input type="hidden" name="next" value="{html.escape(destination, quote=True)}"><button type="submit">Continue</button></form>
<p role="alert">{html.escape(message)}</p></main></body></html>'''.encode()
        return self.respond(status, body)

    def do_GET(self):
        path = urlsplit(self.path).path
        if path == '/ready':
            return self.respond(200)
        if path == '/verify':
            return self.respond(204 if self.server.sessions.valid(self.headers.get('Cookie', '')) else 401)
        if path == '/login':
            destination = local_path(self.headers.get('X-Original-URI', '/'))
            return self.page(destination=destination)
        return self.respond(404)

    def do_POST(self):
        if self.path != '/login':
            return self.respond(404)
        try:
            length = int(self.headers.get('Content-Length', '0'))
            if not 0 < length <= 4096:
                return self.respond(400)
            fields = parse_qs(self.rfile.read(length).decode(), max_num_fields=4)
        except (ValueError, UnicodeError):
            return self.respond(400)
        password = fields.get('password', [''])[0]
        destination = local_path(fields.get('next', ['/'])[0])
        status = self.server.sessions.authenticate(password)
        if status != 200:
            return self.page(status, 'Too many attempts. Try again in a minute.' if status == 429 else 'Incorrect password.', destination)
        token = self.server.sessions.issue()
        cookie = f'{COOKIE}={token}; Path=/; HttpOnly; SameSite=Lax; Max-Age={SESSION_SECONDS}'
        if self.headers.get('X-Forwarded-Proto') == 'https':
            cookie += '; Secure'
        return self.respond(303, headers=[('Set-Cookie', cookie), ('Location', destination)])


def main():
    server = ThreadingHTTPServer(('127.0.0.1', 8083), LoginHandler)
    server.daemon_threads = True
    server.sessions = Sessions(os.environ.get('EMAGE_CLIENT_PASSWORD', ''))
    server.serve_forever()


if __name__ == '__main__':
    main()
