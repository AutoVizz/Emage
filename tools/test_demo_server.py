import io
import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from types import SimpleNamespace
import threading
import unittest
from unittest.mock import Mock, patch
from urllib.error import HTTPError
from urllib.request import Request, build_opener, ProxyHandler

from tools.demo_server import (CONTROL_HEADERS, DemoHandler, DemoState, ROOT,
                               SharedBandwidth, TransferCancelled, create_servers, seed_with_retry)


class BandwidthTests(unittest.TestCase):
    def test_real_bytes_consume_aggregate_transmission_time(self):
        now = [0.0]
        delays = []
        def sleep(delay):
            delays.append(delay)
            now[0] += delay
        bandwidth = SharedBandwidth(100, clock=lambda: now[0], sleeper=sleep)
        bandwidth.charge(25)
        bandwidth.charge(75)
        self.assertEqual(delays, [.25, .75])
        self.assertEqual(now[0], 1)

    def test_ten_connections_share_one_budget(self):
        delays = []
        bandwidth = SharedBandwidth(100, clock=lambda: 0, sleeper=delays.append)
        threads = [threading.Thread(target=bandwidth.charge, args=(100,)) for _ in range(10)]
        for thread in threads: thread.start()
        for thread in threads: thread.join()
        self.assertEqual(sorted(delays), list(range(1, 11)))

    def test_stop_interrupts_reserved_bandwidth_across_subdomains(self):
        manifest = json.loads((ROOT / 'demo-assets/manifest.json').read_text())
        state = DemoState('http://localhost:3233', manifest)
        entered = threading.Event()
        class InterruptibleEvent(threading.Event):
            def wait(self, delay):
                entered.set()
                return super().wait(delay)
        state.runs['12345678'] = (InterruptibleEvent(), __import__('time').monotonic())
        first = state.bucket(100, '12345678', 'gallery')
        self.assertIs(first, state.bucket(100, '12345678', 'gallery'))
        self.assertIsNot(first, state.bucket(100, '12345678', 'other-lane'))
        stopped = []
        def charge():
            try: first.charge(1000000)
            except TransferCancelled: stopped.append(True)
        thread = threading.Thread(target=charge)
        thread.start()
        self.assertTrue(entered.wait(1))
        state.cancel('12345678')
        thread.join(1)
        self.assertFalse(thread.is_alive())
        self.assertEqual(stopped, [True])


class Upstream(BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'
    def log_message(self, *_): pass
    def do_GET(self): self.reply()
    do_POST = do_DELETE = do_HEAD = do_OPTIONS = do_PUT = do_PATCH = do_GET
    def reply(self):
        length = int(self.headers.get('Content-Length', '0'))
        self.server.requests.append((self.command, self.path, dict(self.headers), self.rfile.read(length)))
        body = b'upstream response'
        status = 401 if self.path == '/unauthorized' else 200
        self.send_response(status)
        self.send_header('Content-Type', 'application/octet-stream')
        self.send_header('X-Emage-TilePsotOffsets', '169')
        if self.path == '/chunked':
            self.send_header('Transfer-Encoding', 'chunked')
        else:
            self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        if self.command == 'HEAD': return
        if self.path == '/chunked':
            self.wfile.write(f'{len(body):x}\r\n'.encode() + body + b'\r\n0\r\n\r\n')
        else: self.wfile.write(body)


class ProxyTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.upstream = ThreadingHTTPServer(('127.0.0.1', 0), Upstream)
        cls.upstream.daemon_threads = True
        cls.upstream.requests = []
        cls.manifest = json.loads((ROOT / 'demo-assets/manifest.json').read_text())
        cls.state = DemoState('http://127.0.0.1:' + str(cls.upstream.server_port), cls.manifest)
        cls.proxies = create_servers(cls.state, [0] * 4, public_origin='https://autovizz.github.io')
        cls.proxy = cls.proxies[0]
        for server in (cls.upstream, *cls.proxies):
            threading.Thread(target=server.serve_forever, daemon=True).start()
        cls.opener = build_opener(ProxyHandler({}))
        cls.base = 'http://127.0.0.1:' + str(cls.proxy.server_port)

    @classmethod
    def tearDownClass(cls):
        for server in (*cls.proxies, cls.upstream):
            server.shutdown()
            server.server_close()

    def request(self, path, headers=None, data=None, method=None):
        try:
            with self.opener.open(Request(self.base + path, headers=headers or {}, data=data, method=method), timeout=3) as response:
                return response.status, response.read(), response.headers
        except HTTPError as error:
            with error:
                return error.code, error.read(), error.headers

    def test_every_subdomain_uses_fixed_upstream_without_added_delay(self):
        with patch('tools.demo_server.time.sleep') as sleep, patch.object(self.state, 'bucket', wraps=self.state.bucket) as bucket:
            for host in ('api.example.com', 'anything.example.com', 'nested.anything.example.com'):
                status, body, headers = self.request('/image/a.j2k?level=1', {'Host': host})
                self.assertEqual((status, body), (200, b'upstream response'))
                self.assertIsNone(headers.get('X-Demo-Latency-Ms'))
                method, path, upstream_headers, _ = self.upstream.requests[-1]
                self.assertEqual(path, '/image/a.j2k?level=1')
                self.assertTrue(upstream_headers['Host'].startswith('127.0.0.1:'))
            sleep.assert_not_called()
            bucket.assert_not_called()

    def test_same_host_http_client_cors_is_inferred_without_configuration(self):
        with patch.object(self.state, 'infer_client_origin', True):
            status, body, headers = self.request('/demo/config', {
                'Host': '203.0.113.10:3434', 'Origin': 'http://203.0.113.10:3433'})
            self.assertEqual(status, 200)
            self.assertEqual(headers['Access-Control-Allow-Origin'], 'http://203.0.113.10:3433')
            status, body, headers = self.request('/demo/config', {
                'Host': '203.0.113.10:3434', 'Origin': 'http://different.example:3433'})
            self.assertIsNone(headers.get('Access-Control-Allow-Origin'))

    def test_header_controls_apply_delay_and_are_not_forwarded(self):
        headers = {'X-Demo-Latency-Ms': '60', 'X-Demo-Bytes-Per-Second': '5000',
                   'X-Demo-Run': 'abcdef12', 'X-Demo-Lane': 'compare', 'X-Emage-Layers': '0:2'}
        bucket = Mock()
        with patch.object(self.state, 'bucket', return_value=bucket), patch.object(self.state, 'run_event', return_value=Mock(wait=Mock(return_value=False), is_set=Mock(return_value=False))) as event:
            status, body, response_headers = self.request('/image/a.j2k', headers)
            self.assertEqual(status, 200)
            bucket.charge.assert_called_once_with(len(body))
            event.return_value.wait.assert_called_once_with(.06)
            self.assertEqual(response_headers['X-Demo-Bytes-Per-Second'], '5000')
            sent = self.upstream.requests[-1][2]
            self.assertEqual(sent['X-Emage-Layers'], '0:2')
            for name in CONTROL_HEADERS: self.assertNotIn(name, sent)

    def test_upload_delete_head_and_error_status_are_forwarded(self):
        for method, data in (('POST', b'image bytes'), ('DELETE', None), ('HEAD', None)):
            status, body, headers = self.request('/image/new.j2k', {'X-Emage-Password': 'test-only-password', 'Content-Type': 'image/jp2'}, data, method)
            self.assertEqual(status, 200)
            sent_method, _, sent_headers, sent_body = self.upstream.requests[-1]
            self.assertEqual(sent_method, method)
            self.assertEqual(sent_headers['X-Emage-Password'], 'test-only-password')
            self.assertEqual(sent_body, data or b'')
            if method == 'HEAD': self.assertEqual(body, b'')
        self.assertEqual(self.request('/unauthorized')[0], 401)

    def test_chunked_upstream_is_delimited_correctly(self):
        status, body, headers = self.request('/chunked')
        self.assertEqual((status, body), (200, b'upstream response'))
        self.assertIsNone(headers.get('Transfer-Encoding'))
        self.assertEqual(headers['Connection'], 'close')

    def test_invalid_controls_fail_before_forwarding(self):
        for headers in ({'X-Demo-Latency-Ms': '-1'}, {'X-Demo-Latency-Ms': '10001'},
                        {'X-Demo-Bytes-Per-Second': 'oops'}, {'X-Demo-Run': '../secret'},
                        {'X-Demo-Run': 'abcdef12'}):
            before = len(self.upstream.requests)
            self.assertEqual(self.request('/images', headers)[0], 400)
            self.assertEqual(len(self.upstream.requests), before)

    def test_pages_preflight_covers_shaping_and_upload_headers(self):
        status, _, headers = self.request('/image/a.j2k', {'Origin': 'https://autovizz.github.io', 'Access-Control-Request-Method': 'GET', 'Access-Control-Request-Headers': ', '.join(CONTROL_HEADERS)}, method='OPTIONS')
        self.assertEqual(status, 204)
        self.assertEqual(headers['Access-Control-Allow-Origin'], 'https://autovizz.github.io')
        for name in (*CONTROL_HEADERS, 'X-Emage-Layers', 'X-Emage-Password'):
            self.assertIn(name, headers['Access-Control-Allow-Headers'])
        status, _, headers = self.request('/images', {'Origin': 'https://autovizz.github.io'})
        self.assertEqual(headers['Timing-Allow-Origin'], 'https://autovizz.github.io')
        self.assertIn('X-Emage-TilePsotOffsets', headers['Access-Control-Expose-Headers'])

    def test_request_host_advertises_four_transfer_ports(self):
        status, body, _ = self.request('/demo/config', {'Host': '203.0.113.10:3434'})
        config = json.loads(body)
        self.assertEqual(status, 200)
        self.assertEqual(config['shaping'], 'headers')
        origins = [f'http://203.0.113.10:{server.server_port}' for server in self.proxies]
        self.assertEqual(config['transport'], {'emageOrigins': origins[:2], 'pngOrigins': origins[2:]})
        for server in self.proxies:
            with self.opener.open(f'http://127.0.0.1:{server.server_port}/images', timeout=3) as response:
                self.assertEqual(response.read(), b'upstream response')

    def test_png_uses_headers_and_fixed_public_fixture_allowlist(self):
        image = self.manifest['images'][0]
        status, body, headers = self.request('/demo/png/' + image['id'] + '.png')
        self.assertEqual(status, 200)
        self.assertEqual(body, (ROOT / image['png']).read_bytes())
        self.assertEqual(headers['Content-Type'], 'image/png')
        self.assertEqual(self.request('/demo/png/../../.env')[0], 404)

    def test_cancel_only_sets_local_run_state(self):
        before = len(self.upstream.requests)
        self.assertEqual(self.request('/demo/cancel/abcdef12', method='POST')[0], 200)
        self.assertTrue(self.state.run_event('abcdef12').is_set())
        self.assertEqual(len(self.upstream.requests), before)
        self.assertEqual(self.request('/demo/cancel/abcdef12', {'Origin': 'https://elsewhere.example'}, method='POST')[0], 403)

    def test_invalid_public_settings_fail_before_binding(self):
        for options in ({'public_origin': 'https://user:secret@host'}, {'public_origin': 'https://host/path'}, {'transport_origins': ['https://one.example'] * 4}):
            with patch('tools.demo_server.ThreadingHTTPServer') as server:
                with self.assertRaises(ValueError): create_servers(self.state, [0] * 4, **options)
                server.assert_not_called()

    def test_seed_retries_startup(self):
        with patch('tools.demo_server.seed', side_effect=[RuntimeError('API unavailable'), None]) as seed, patch('tools.demo_server.time.sleep') as sleep:
            seed_with_retry(self.state, attempts=3)
        self.assertEqual(seed.call_count, 2)
        sleep.assert_called_once_with(2)


if __name__ == '__main__':
    unittest.main()
