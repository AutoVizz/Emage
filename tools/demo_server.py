#!/usr/bin/env python3
"""Forward all hosts to the Emage API; shape responses only when headers request it."""
import argparse
import http.client
import json
import os
from pathlib import Path
import re
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.error import HTTPError, URLError
from urllib.parse import quote, unquote, urlsplit
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parents[1]
PROFILES = {
    'slow': {'label': 'Constrained', 'bytesPerSecond': 96 * 1024, 'latencyMs': 180},
    'balanced': {'label': 'Everyday', 'bytesPerSecond': 512 * 1024, 'latencyMs': 60},
    'demo': {'label': 'Demo', 'bytesPerSecond': 2 * 1024 * 1024, 'latencyMs': 30},
    'fast': {'label': 'Fast', 'bytesPerSecond': 4 * 1024 * 1024, 'latencyMs': 20},
}
RESPONSE_HEADERS = (
    'Content-Type', 'Content-Length', 'X-Emage-Framing', 'X-Emage-Layers',
    'X-Emage-TotalLayers', 'X-Emage-RemainingLayers', 'X-Emage-TilePsotOffsets',
)
CONTROL_HEADERS = ('X-Demo-Latency-Ms', 'X-Demo-Bytes-Per-Second', 'X-Demo-Run', 'X-Demo-Lane')
HOP_HEADERS = {'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade'}
CANCEL_ROUTE = re.compile(r'^/demo/cancel/([a-f0-9]{8,32})$')


class TransferCancelled(Exception):
    pass


class SharedBandwidth:
    def __init__(self, rate, clock=time.monotonic, sleeper=time.sleep, cancelled=None):
        self.rate, self.clock, self.sleeper = rate, clock, sleeper
        self.cancelled = cancelled
        self.next_time = 0
        self.touched = clock()
        self.lock = threading.Lock()

    def charge(self, size):
        if self.cancelled and self.cancelled.is_set():
            raise TransferCancelled()
        # Reserve aggregate transmission time under the lock; sleep outside it
        # so concurrent connections share bandwidth rather than multiply it.
        with self.lock:
            now = self.clock()
            finish = max(now, self.next_time) + size / self.rate
            self.next_time = finish
            self.touched = now
        delay = max(0, finish - self.clock())
        if self.cancelled:
            if self.cancelled.wait(delay):
                raise TransferCancelled()
        else:
            self.sleeper(delay)


class DemoState:
    def __init__(self, api, manifest):
        parsed = urlsplit(api)
        if parsed.scheme not in ('http', 'https') or not parsed.netloc or parsed.username or parsed.password or parsed.query or parsed.fragment:
            raise ValueError('API must be an HTTP(S) base URL without credentials, query, or fragment.')
        self.api = api.rstrip('/')
        self.manifest = manifest
        self.images = {image['serverPath']: image for image in manifest['images']}
        self.pngs = {image['id'] + '.png': ROOT / image['png'] for image in manifest['images']}
        self.buckets = {}
        self.runs = {}
        self.transport = {'emageOrigins': [], 'pngOrigins': []}
        self.allowed_origins = set()
        self.lock = threading.RLock()

    def run_event(self, run):
        with self.lock:
            now = time.monotonic()
            self.runs = {key: value for key, value in self.runs.items() if now - value[1] < 600}
            event = self.runs.get(run, (threading.Event(), now))[0]
            self.runs[run] = (event, now)
            return event

    def cancel(self, run):
        self.run_event(run).set()

    def bucket(self, rate, run, lane):
        key = (rate, run, lane)
        with self.lock:
            now = time.monotonic()
            self.buckets = {k: v for k, v in self.buckets.items() if now - v.touched < 600 or v.next_time > now}
            if key not in self.buckets:
                if len(self.buckets) >= 512:
                    raise RuntimeError('Too many active demo runs. Wait for previous runs to finish.')
                self.buckets[key] = SharedBandwidth(rate, cancelled=self.run_event(run) if run else None)
            return self.buckets[key]

class DemoHandler(BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'

    def log_message(self, format, *args):
        # Never log passwords or shaping headers.
        super().log_message(format, *args)

    def end_headers(self):
        origin = self.headers.get('Origin')
        if origin in self.server.state.allowed_origins:
            self.send_header('Access-Control-Allow-Origin', origin)
            self.send_header('Vary', 'Origin')
            self.send_header('Timing-Allow-Origin', origin)
            self.send_header('Access-Control-Expose-Headers', ', '.join(RESPONSE_HEADERS))
        super().end_headers()

    def json(self, data, status=200):
        body = json.dumps(data).encode()
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        if self.command != 'HEAD':
            self.wfile.write(body)

    def shaping(self):
        def number(name, maximum):
            raw = self.headers.get(name)
            if raw is None:
                return 0
            if not raw.isascii() or not raw.isdigit() or not 0 <= int(raw) <= maximum:
                raise ValueError(f'{name} must be an integer between 0 and {maximum}.')
            return int(raw)
        latency = number('X-Demo-Latency-Ms', 10000)
        rate = number('X-Demo-Bytes-Per-Second', 100 * 1024 * 1024)
        run, lane = self.headers.get('X-Demo-Run', ''), self.headers.get('X-Demo-Lane', '')
        if run and not re.fullmatch(r'[a-f0-9]{8,32}', run):
            raise ValueError('Invalid X-Demo-Run.')
        if lane and not re.fullmatch(r'[a-z0-9-]{1,24}', lane):
            raise ValueError('Invalid X-Demo-Lane.')
        if bool(run) != bool(lane):
            raise ValueError('Supply X-Demo-Run and X-Demo-Lane together.')
        # Ungrouped requests never share a bandwidth budget accidentally.
        bucket = (self.server.state.bucket(rate, run, lane) if run else SharedBandwidth(rate)) if rate else None
        cancelled = self.server.state.run_event(run) if run else None
        return latency, rate, bucket, cancelled

    def do_OPTIONS(self):
        if self.headers.get('Origin') not in self.server.state.allowed_origins:
            return self.proxy()
        self.send_response(204)
        self.send_header('Access-Control-Allow-Methods', 'GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', ', '.join(('Content-Type', 'X-Emage-Layers', 'X-Emage-Password', *CONTROL_HEADERS)))
        self.send_header('Access-Control-Max-Age', '600')
        self.send_header('Content-Length', '0')
        self.end_headers()

    def do_POST(self):
        match = CANCEL_ROUTE.fullmatch(urlsplit(self.path).path)
        if not match:
            return self.proxy()
        origin = self.headers.get('Origin')
        if origin and origin not in self.server.state.allowed_origins:
            return self.json({'error': 'Origin not allowed.'}, 403)
        self.server.state.cancel(match[1])
        return self.json({'stopped': True})

    def do_GET(self):
        path = urlsplit(self.path).path
        if path == '/demo/config':
            transport = self.server.state.transport
            if not transport['emageOrigins']:
                host = self.headers.get('Host', 'localhost')
                scheme = self.headers.get('X-Forwarded-Proto', 'http').split(',')[0].strip()
                parsed = urlsplit(f'{scheme}://{host}')
                if parsed.scheme not in ('http', 'https') or not parsed.hostname or parsed.username or parsed.password:
                    return self.json({'error': 'Invalid public host.'}, 400)
                hostname = parsed.hostname
                if ':' in hostname or re.fullmatch(r'[0-9.]+', hostname):
                    transport = {'emageOrigins': [], 'pngOrigins': []}
                else:
                    # api.example.com -> e1.example.com; localhost -> e1.localhost.
                    domain = hostname.split('.', 1)[1] if len(hostname.split('.')) > 2 else hostname
                    suffix = f':{parsed.port}' if parsed.port else ''
                    origins = [f'{parsed.scheme}://{label}.{domain}{suffix}' for label in ('e1', 'e2', 'p1', 'p2')]
                    transport = {'emageOrigins': origins[:2], 'pngOrigins': origins[2:]}
            return self.json({'ready': True, 'profiles': PROFILES, 'images': len(self.server.state.images),
                              'publicSamples': True, 'transport': transport, 'shaping': 'headers'})
        if path.startswith('/demo/png/'):
            name = unquote(path[len('/demo/png/'):])
            source = self.server.state.pngs.get(name)
            if source is None:
                return self.json({'error': 'Unknown public PNG.'}, 404)
            return self.proxy(source)
        return self.proxy()

    def do_HEAD(self):
        return self.proxy()

    def do_PUT(self):
        return self.proxy()

    do_PATCH = do_DELETE = do_PUT

    def proxy(self, png=None):
        try:
            latency, rate, bucket, cancelled = self.shaping()
            length = int(self.headers.get('Content-Length', '0'))
            if length < 0:
                raise ValueError('Invalid Content-Length.')
            if self.headers.get('Transfer-Encoding'):
                raise ValueError('Send a Content-Length for request bodies.')
        except ValueError as error:
            self.close_connection = True
            return self.json({'error': str(error)}, 400)
        except RuntimeError as error:
            return self.json({'error': str(error)}, 503)
        if latency:
            if cancelled is not None:
                if cancelled.wait(latency / 1000):
                    self.close_connection = True
                    return
            else:
                time.sleep(latency / 1000)
        connection = response = None
        try:
            if png is not None:
                response = png.open('rb')
                status = 200
                headers = [('Content-Type', 'image/png'), ('Content-Length', str(png.stat().st_size))]
            else:
                upstream = urlsplit(self.server.state.api)
                cls = http.client.HTTPSConnection if upstream.scheme == 'https' else http.client.HTTPConnection
                connection = cls(upstream.hostname, upstream.port, timeout=30)
                # A client Host or absolute request URL never selects the upstream.
                path = upstream.path.rstrip('/') + '/' + self.path.lstrip('/')
                blocked = HOP_HEADERS | {part.strip().lower() for part in self.headers.get('Connection', '').split(',')}
                connection.putrequest(self.command, path, skip_accept_encoding=True)
                for name, value in self.headers.items():
                    if name.lower() not in blocked | {'host', *(h.lower() for h in CONTROL_HEADERS)}:
                        connection.putheader(name, value)
                connection.endheaders()
                remaining = length
                while remaining:
                    chunk = self.rfile.read(min(65536, remaining))
                    if not chunk:
                        raise OSError('Incomplete request body.')
                    connection.send(chunk)
                    remaining -= len(chunk)
                response = connection.getresponse()
                status = response.status
                blocked = HOP_HEADERS | {part.strip().lower() for part in response.getheader('Connection', '').split(',')}
                replace_cors = self.headers.get('Origin') in self.server.state.allowed_origins
                headers = [(name, value) for name, value in response.getheaders()
                           if name.lower() not in blocked and not (replace_cors and name.lower().startswith('access-control-'))]
            self.send_response(status)
            for name, value in headers:
                if (latency or rate) and name.lower() == 'cache-control':
                    continue
                self.send_header(name, value)
            if latency or rate:
                self.send_header('Cache-Control', 'no-store')
            if rate:
                self.send_header('X-Demo-Bytes-Per-Second', str(rate))
            if latency:
                self.send_header('X-Demo-Latency-Ms', str(latency))
            if not any(name.lower() == 'content-length' for name, _ in headers):
                self.send_header('Connection', 'close')
                self.close_connection = True
            self.end_headers()
            if self.command != 'HEAD':
                read = getattr(response, 'read1', response.read)
                while data := read(4096):
                    if cancelled is not None and cancelled.is_set():
                        raise TransferCancelled()
                    if bucket:
                        bucket.charge(len(data))
                    self.wfile.write(data)
                    self.wfile.flush()
        except (TransferCancelled, BrokenPipeError, ConnectionResetError):
            self.close_connection = True
        except (OSError, http.client.HTTPException):
            self.close_connection = True
            if response is None:
                self.json({'error': 'Cannot reach the Emage API.'}, 502)
        finally:
            if response:
                response.close()
            if connection:
                connection.close()


def upload_password():
    if 'EMAGE_UPLOAD_PASSWORD' in os.environ:
        return os.environ['EMAGE_UPLOAD_PASSWORD']
    env_file = ROOT.parent / 'Emage-Server' / '.env'
    if env_file.exists():
        for line in env_file.read_text().splitlines():
            if line.startswith('EMAGE_UPLOAD_PASSWORD='):
                value = line.split('=', 1)[1].strip()
                if len(value) > 1 and value[0] in ('"', "'") and value[-1] == value[0]:
                    value = value[1:-1]
                return value
    return ''


def seed(state):
    """Upload only reserved public fixtures, never send keys or overwrite users' paths."""
    password = upload_password()
    for path, image in state.images.items():
        endpoint = state.api + '/image/' + quote(path, safe='/')
        try:
            with urlopen(Request(endpoint, headers={'X-Emage-Layers': 'meta'}), timeout=5) as response:
                metadata = json.load(response)
            if ((metadata.get('metadata') or {}).get('demo') or {}).get('build') == state.manifest['build']:
                continue
        except HTTPError as error:
            if error.code != 404:
                raise RuntimeError(f'Emage returned HTTP {error.code} while checking demo images.') from None
        except (URLError, OSError):
            raise RuntimeError('Emage API is unavailable. Start it on port 3233 first (docker compose up -d --build in Emage-Server).') from None
        if not password:
            raise RuntimeError('Demo images need uploading. Set EMAGE_UPLOAD_PASSWORD or configure Emage-Server/.env. The password is used locally and never included in the article.')
        body = (ROOT / image['j2k']).read_bytes()
        try:
            with urlopen(Request(endpoint, data=body, headers={'Content-Type': 'image/jp2', 'X-Emage-Password': password}, method='POST'), timeout=30) as response:
                response.read()
        except HTTPError as error:
            raise RuntimeError(f'Demo upload returned HTTP {error.code}. Check EMAGE_UPLOAD_PASSWORD and recreate the API container if its configuration changed.') from None
        print(f"Seeded public sample: {image['title']}")


def normalize_origin(value):
    parsed = urlsplit(value)
    if (parsed.scheme not in ('http', 'https') or not parsed.hostname or
            parsed.username or parsed.password or parsed.path not in ('', '/') or
            parsed.query or parsed.fragment):
        raise ValueError('Public origins must be HTTP(S) origins without credentials or paths.')
    # Validate the port before binding any listeners.
    parsed.port
    return f'{parsed.scheme}://{parsed.netloc}'


def create_servers(state, port, bind='127.0.0.1', public_origin=None, transport_origins=None):
    """One HTTP listener for every subdomain; Cloudflare Tunnel terminates TLS."""
    if public_origin:
        public_origin = normalize_origin(public_origin)
    if transport_origins:
        transport_origins = [normalize_origin(value) for value in transport_origins]
        if len(transport_origins) != 4 or len(set(transport_origins)) != 4:
            raise ValueError('Specify four distinct public transport origins.')
    state.allowed_origins = {public_origin} if public_origin else {'https://autovizz.github.io'}
    if transport_origins:
        state.transport = {'emageOrigins': transport_origins[:2], 'pngOrigins': transport_origins[2:]}
    server = ThreadingHTTPServer((bind, port), DemoHandler)
    server.state, server.daemon_threads = state, True
    return [server]


def seed_with_retry(state, attempts=1, delay=2):
    if attempts < 1:
        raise ValueError('Seed attempts must be at least 1.')
    for attempt in range(attempts):
        try:
            seed(state)
            return
        except RuntimeError as error:
            if attempt + 1 == attempts:
                raise
            print(f'{error} Retrying demo setup ({attempt + 1}/{attempts})…', flush=True)
            time.sleep(delay)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--port', type=int, default=443)
    parser.add_argument('--api', default=os.environ.get('DEMO_API_URL', 'http://localhost:3233'))
    parser.add_argument('--bind', default='127.0.0.1')
    parser.add_argument('--public-origin', default=os.environ.get('DEMO_PUBLIC_ORIGIN'))
    parser.add_argument('--transport-origins', default=os.environ.get('DEMO_TRANSPORT_ORIGINS'), help='Four comma-separated public origins, if different from the listener ports.')
    parser.add_argument('--seed-attempts', type=int, default=1)
    parser.add_argument('--skip-seed', action='store_true', help='Use fixtures already uploaded to the API.')
    args = parser.parse_args()
    try:
        manifest = json.loads((ROOT / 'demo-assets' / 'manifest.json').read_text())
        state = DemoState(args.api, manifest)
        if not args.skip_seed:
            seed_with_retry(state, args.seed_attempts)
        origins = args.transport_origins.split(',') if args.transport_origins else None
        servers = create_servers(state, args.port, bind=args.bind, public_origin=args.public_origin,
                                 transport_origins=origins)
    except (OSError, ValueError, RuntimeError) as error:
        parser.exit(1, f'{error}\n')
    print(f'Emage proxy: http://{args.bind}:{servers[0].server_address[1]} -> {state.api}', flush=True)
    print('All hosts share this listener. No shaping headers means no added latency or rate limit.', flush=True)
    try:
        servers[0].serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        servers[0].server_close()


if __name__ == '__main__':
    main()
