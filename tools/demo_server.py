#!/usr/bin/env python3
"""Serve the article and shape real response bodies from the existing Emage API.

Each (run, lane, profile) has ONE shared byte budget, including all ten gallery
requests. Each competing strategy gets its own identical budget. This is a
proxy with fixed upstream and fixture allowlists. It binds to loopback by default;
Docker can expose its four transport listeners separately from the static site.
"""
import argparse
import http.client
import json
import os
from pathlib import Path
import re
import threading
import time
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
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
ROUTE = re.compile(r'^/demo/net/(slow|balanced|demo|fast)/([a-f0-9]{8,32})/([a-z0-9-]{1,24})/(api|png)/(.+)$')
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

    def bucket(self, profile, run, lane):
        key = (profile, run, lane)
        with self.lock:
            now = time.monotonic()
            self.buckets = {k: v for k, v in self.buckets.items() if now - v.touched < 600 or v.next_time > now}
            if key not in self.buckets:
                if len(self.buckets) >= 512:
                    raise RuntimeError('Too many active demo runs. Wait for previous runs to finish.')
                self.buckets[key] = SharedBandwidth(PROFILES[profile]['bytesPerSecond'], cancelled=self.run_event(run))
            return self.buckets[key]

    def source(self, kind, resource):
        resource = unquote(resource)
        if kind == 'api' and resource.startswith('image/') and resource[6:] in self.images:
            return self.api + '/image/' + quote(resource[6:], safe='/')
        if kind == 'png' and resource in self.pngs:
            return self.pngs[resource]
        raise ValueError('Only the ten public blog fixtures can be requested through this proxy.')


class DemoHandler(SimpleHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def end_headers(self):
        origin = self.headers.get('Origin')
        if origin in self.server.state.allowed_origins:
            self.send_header('Access-Control-Allow-Origin', origin)
            self.send_header('Vary', 'Origin')
            self.send_header('Timing-Allow-Origin', origin)
            self.send_header('Access-Control-Expose-Headers', ', '.join(RESPONSE_HEADERS))
        super().end_headers()

    def do_HEAD(self):
        if getattr(self.server, 'transport_only', False):
            return self.send_error(405)
        return super().do_HEAD()

    def do_OPTIONS(self):
        if not ROUTE.fullmatch(urlsplit(self.path).path) or self.headers.get('Origin') not in self.server.state.allowed_origins:
            return self.json({'error': 'Origin or path not allowed.'}, 403)
        self.send_response(204)
        self.send_header('Access-Control-Allow-Methods', 'GET, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'X-Emage-Layers')
        self.send_header('Access-Control-Max-Age', '600')
        self.send_header('Content-Length', '0')
        self.end_headers()

    def do_POST(self):
        match = CANCEL_ROUTE.fullmatch(urlsplit(self.path).path)
        origin = self.headers.get('Origin')
        if not match or getattr(self.server, 'transport_only', False) or (origin and origin not in self.server.state.allowed_origins):
            return self.json({'error': 'Not allowed.'}, 403)
        self.server.state.cancel(match[1])
        return self.json({'stopped': True})

    def json(self, data, status=200):
        body = json.dumps(data).encode()
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', 'no-store')
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        path = urlsplit(self.path).path
        if path == '/demo/config' and not getattr(self.server, 'transport_only', False):
            return self.json({'ready': True, 'profiles': PROFILES, 'images': len(self.server.state.images), 'publicSamples': True, 'transport': self.server.state.transport})
        match = ROUTE.fullmatch(path)
        if match:
            return self.throttled(*match.groups())
        if path.startswith('/demo/'):
            return self.json({'error': 'Invalid demo route or network profile.'}, 400)
        if getattr(self.server, 'transport_only', False):
            return self.json({'error': 'Transport endpoint only.'}, 404)
        if any(part.startswith('.') for part in unquote(path).split('/') if part):
            return self.json({'error': 'Not found'}, 404)
        return super().do_GET()

    def throttled(self, profile, run, lane, kind, resource):
        try:
            source = self.server.state.source(kind, resource)
            bucket = self.server.state.bucket(profile, run, lane)
        except ValueError as error:
            return self.json({'error': str(error)}, 400)
        except RuntimeError as error:
            return self.json({'error': str(error)}, 503)
        # An added delay per request, not a claim to emulate TCP, loss, or radio.
        cancelled = self.server.state.run_event(run)
        if cancelled.wait(PROFILES[profile]['latencyMs'] / 1000):
            self.close_connection = True
            return
        response = None
        try:
            if kind == 'api':
                headers = {'X-Emage-Layers': self.headers.get('X-Emage-Layers', 'all')}
                try:
                    response = urlopen(Request(source, headers=headers), timeout=30)
                except HTTPError as error:
                    response = error
                status = response.code
                headers = {name: response.headers[name] for name in RESPONSE_HEADERS if response.headers.get(name) is not None}
            else:
                response = source.open('rb')
                status = 200
                headers = {'Content-Type': 'image/png', 'Content-Length': str(source.stat().st_size)}
        except (URLError, OSError, http.client.HTTPException):
            if response:
                response.close()
            return self.json({'error': 'Cannot reach the Emage API. Start Emage-Server and run npm run blog again.'}, 502)
        try:
            self.send_response(status)
            for name, value in headers.items():
                self.send_header(name, value)
            self.send_header('Cache-Control', 'no-store')
            self.send_header('X-Demo-Bytes-Per-Second', str(PROFILES[profile]['bytesPerSecond']))
            self.send_header('X-Demo-Latency-Ms', str(PROFILES[profile]['latencyMs']))
            # Kestrel may omit Content-Length. Closing delimits that response.
            if 'Content-Length' not in headers:
                self.send_header('Connection', 'close')
                self.close_connection = True
            self.end_headers()
            while data := response.read(4096):
                bucket.charge(len(data))
                self.wfile.write(data)
                self.wfile.flush()
        except (TransferCancelled, BrokenPipeError, ConnectionResetError, TimeoutError, http.client.HTTPException):
            self.close_connection = True
        finally:
            response.close()


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


def create_servers(state, port, bind='127.0.0.1', public_origin=None,
                   transport_ports=None, transport_origins=None):
    """Four isolated socket pools, five gallery images each; shared row budgets.

    Local runs allocate auxiliary ports automatically. Docker uses fixed ports
    and advertises browser-accessible origins instead of container addresses.
    """
    if transport_ports is not None and (len(transport_ports) != 4 or
            len(set(transport_ports)) != 4 or any(not 1 <= value <= 65535 for value in transport_ports)):
        raise ValueError('Specify four distinct transport ports between 1 and 65535.')
    if public_origin:
        public_origin = normalize_origin(public_origin)
    if transport_origins is not None:
        transport_origins = [normalize_origin(value) for value in transport_origins]
        if len(transport_origins) != 4 or len(set(transport_origins)) != 4:
            raise ValueError('Specify four distinct public transport origins.')
    servers = []
    try:
        page = ThreadingHTTPServer((bind, port), DemoHandler)
        page.state, page.daemon_threads, page.transport_only = state, True, False
        servers.append(page)
        page_port = page.server_address[1]
        state.allowed_origins = ({public_origin} if public_origin else
                                 {f'http://localhost:{page_port}', f'http://127.0.0.1:{page_port}'})
        if public_origin:
            public = urlsplit(public_origin)
            if public.hostname in ('localhost', '127.0.0.1'):
                suffix = f':{public.port}' if public.port else ''
                state.allowed_origins.update(f'{public.scheme}://{host}{suffix}' for host in ('localhost', '127.0.0.1'))
        else:
            public = urlsplit(f'http://127.0.0.1:{page_port}')
        index = 0
        for name in ('emageOrigins', 'pngOrigins'):
            state.transport[name] = []
            for _ in range(2):
                server = ThreadingHTTPServer((bind, transport_ports[index] if transport_ports else 0), DemoHandler)
                server.state, server.daemon_threads, server.transport_only = state, True, True
                servers.append(server)
                host = f'[{public.hostname}]' if ':' in public.hostname else public.hostname
                origin = (transport_origins[index] if transport_origins else
                          f'{public.scheme}://{host}:{server.server_address[1]}')
                if origin in state.allowed_origins:
                    raise ValueError('Transport origins must be separate from the page origin.')
                state.transport[name].append(origin)
                index += 1
        return servers
    except (OSError, ValueError):
        for server in servers:
            server.server_close()
        raise


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
    parser.add_argument('--port', type=int, default=8082)
    parser.add_argument('--api', default=os.environ.get('DEMO_API_URL', 'http://localhost:3233'))
    parser.add_argument('--bind', default='127.0.0.1')
    parser.add_argument('--public-origin', default=os.environ.get('DEMO_PUBLIC_ORIGIN'))
    parser.add_argument('--transport-ports', help='Four comma-separated listener ports (otherwise allocated automatically).')
    parser.add_argument('--transport-origins', default=os.environ.get('DEMO_TRANSPORT_ORIGINS'), help='Four comma-separated public origins, if different from the listener ports.')
    parser.add_argument('--seed-attempts', type=int, default=1)
    parser.add_argument('--skip-seed', action='store_true', help='Use fixtures already uploaded to the API.')
    args = parser.parse_args()
    try:
        manifest = json.loads((ROOT / 'demo-assets' / 'manifest.json').read_text())
        state = DemoState(args.api, manifest)
        if not args.skip_seed:
            seed_with_retry(state, args.seed_attempts)
        ports = [int(value) for value in args.transport_ports.split(',')] if args.transport_ports else None
        origins = args.transport_origins.split(',') if args.transport_origins else None
        servers = create_servers(state, args.port, bind=args.bind, public_origin=args.public_origin,
                                 transport_ports=ports, transport_origins=origins)
    except (OSError, ValueError, RuntimeError) as error:
        parser.exit(1, f'{error}\nIf the UI port is occupied, pass --port 8085.\n')
    page_origin = args.public_origin or f'http://localhost:{servers[0].server_address[1]}'
    print(f'Interactive article: {page_origin}/blog.html', flush=True)
    print('Four independent gallery origins; each strategy still shares one bandwidth budget.', flush=True)
    for server in servers[1:]:
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
    try:
        servers[0].serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        for server in servers[1:]:
            server.shutdown()
        for server in servers:
            server.server_close()


if __name__ == '__main__':
    main()
