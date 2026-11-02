import io
import json
from types import SimpleNamespace
import threading
import unittest
from unittest.mock import Mock, patch

from tools.demo_server import DemoHandler, DemoState, PROFILES, ROOT, SharedBandwidth, TransferCancelled, create_servers, seed_with_retry


class ThrottlingTests(unittest.TestCase):
    def test_actual_body_bytes_consume_time(self):
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
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()
        self.assertEqual(sorted(delays), list(range(1, 11)))
        self.assertEqual(bandwidth.next_time, 10)

    def setUp(self):
        manifest = json.loads((ROOT / 'demo-assets' / 'manifest.json').read_text())
        self.state = DemoState('http://localhost:3233', manifest)

    def test_budgets_are_shared_within_a_lane_and_isolated_between_strategies(self):
        first = self.state.bucket('slow', '12345678', 'gallery-emage')
        self.assertIs(first, self.state.bucket('slow', '12345678', 'gallery-emage'))
        self.assertIsNot(first, self.state.bucket('slow', '12345678', 'gallery-png'))
        self.assertIsNot(first, self.state.bucket('slow', 'abcdef12', 'gallery-emage'))
        self.assertEqual(first.rate, 96 * 1024)
        self.assertEqual(self.state.bucket('fast', '12345678', 'gallery-emage').rate, 4 * 1024 * 1024)
        self.assertEqual(self.state.bucket('demo', '12345678', 'gallery-emage').rate, 2 * 1024 * 1024)

    def test_demo_profile_routes_to_real_png_with_two_mib_shared_rate(self):
        handler = self.handler()
        image = self.state.manifest['images'][0]
        handler.path = '/demo/net/demo/12345678/gallery-png/png/' + image['id'] + '.png'
        handler.throttled = Mock()
        handler.do_GET()
        handler.throttled.assert_called_once_with('demo', '12345678', 'gallery-png', 'png', image['id'] + '.png')
        delays = []
        bucket = SharedBandwidth(PROFILES['demo']['bytesPerSecond'], clock=lambda: 0, sleeper=delays.append)
        self.state.bucket = lambda *_: bucket
        cancelled = Mock()
        cancelled.wait.return_value = False
        self.state.run_event = lambda _: cancelled
        DemoHandler.throttled(handler, 'demo', '12345678', 'gallery-png', 'png', image['id'] + '.png')
        self.assertEqual(handler.wfile.getvalue(), (ROOT / image['png']).read_bytes())
        self.assertEqual(handler.sent_headers['X-Demo-Bytes-Per-Second'], str(2 * 1024 * 1024))
        self.assertAlmostEqual(max(delays), image['pngBytes'] / (2 * 1024 * 1024))
        cancelled.wait.assert_called_once_with(.03)

    def test_controls_only_mode_does_not_serve_client_or_backend_files(self):
        for path in ('/blog.html', '/tools/demo_server.py', '/index.html'):
            handler = self.handler()
            handler.server.controls_only = True
            handler.path = path
            handler.do_GET()
            self.assertEqual(handler.status, 404)
        handler = self.handler()
        handler.server.controls_only = True
        handler.path = '/demo/config'
        handler.do_GET()
        self.assertTrue(json.loads(handler.wfile.getvalue())['ready'])

    def test_only_reserved_fixture_paths_are_proxied(self):
        image = self.state.manifest['images'][0]
        self.assertEqual(self.state.source('api', 'image/' + image['serverPath']), 'http://localhost:3233/image/' + image['serverPath'])
        self.assertEqual(self.state.source('png', image['id'] + '.png'), ROOT / image['png'])
        for kind, path in [('api', 'image/private.j2k'), ('api', 'image/../../.env'), ('api', 'image/%2e%2e/.env'), ('png', '../.env'), ('api', 'http://example.com/')]:
            with self.assertRaises(ValueError):
                self.state.source(kind, path)

    def test_upstream_url_does_not_accept_embedded_credentials(self):
        for url in ['file:///tmp', 'http://user:secret@host', 'http://host/?key=secret']:
            with self.assertRaises(ValueError):
                DemoState(url, self.state.manifest)

    def handler(self):
        handler = object.__new__(DemoHandler)
        handler.server = SimpleNamespace(state=self.state)
        handler.headers = {'X-Emage-Layers': '0:2', 'X-Emage-Password': 'must-not-forward', 'Authorization': 'must-not-forward'}
        handler.wfile = io.BytesIO()
        handler.sent_headers = {}
        handler.send_response = lambda status: setattr(handler, 'status', status)
        handler.send_header = handler.sent_headers.__setitem__
        handler.end_headers = lambda: None
        return handler

    def test_proxy_paces_real_chunks_preserves_framing_and_drops_credentials(self):
        handler = self.handler()
        body = bytes(range(256)) * 40
        upstream = io.BytesIO(body)
        upstream.code = 200
        upstream.headers = {'Content-Type': 'image/jp2', 'Content-Length': str(len(body)), 'X-Emage-TilePsotOffsets': '169', 'X-Emage-Framing': 'headers+packets'}
        charges = []
        self.state.bucket = lambda *_: SimpleNamespace(charge=charges.append)
        cancelled = Mock()
        cancelled.wait.return_value = False
        self.state.run_event = lambda _: cancelled
        requests = []
        with patch('tools.demo_server.urlopen', side_effect=lambda request, **_: requests.append(request) or upstream):
            handler.throttled('slow', '12345678', 'gallery-emage', 'api', 'image/' + self.state.manifest['images'][0]['serverPath'])
        self.assertEqual(handler.wfile.getvalue(), body)
        self.assertEqual(charges, [4096, 4096, 2048])
        self.assertEqual(sum(charges), len(body))
        self.assertEqual(handler.sent_headers['X-Emage-TilePsotOffsets'], '169')
        self.assertEqual(handler.sent_headers['Cache-Control'], 'no-store')
        self.assertEqual(dict(requests[0].header_items()), {'X-emage-layers': '0:2'})
        cancelled.wait.assert_called_once_with(PROFILES['slow']['latencyMs'] / 1000)
        self.assertTrue(upstream.closed)

    def test_png_uses_the_same_shaping_and_actual_file_body(self):
        handler = self.handler()
        image = self.state.manifest['images'][0]
        charges = []
        self.state.bucket = lambda *_: SimpleNamespace(charge=charges.append)
        cancelled = Mock()
        cancelled.wait.return_value = False
        self.state.run_event = lambda _: cancelled
        handler.throttled('balanced', '12345678', 'gallery-png', 'png', image['id'] + '.png')
        self.assertEqual(handler.wfile.getvalue(), (ROOT / image['png']).read_bytes())
        self.assertEqual(sum(charges), image['pngBytes'])
        self.assertEqual(handler.sent_headers['Content-Length'], str(image['pngBytes']))

    def test_transport_origins_are_separate_but_rate_limits_are_shared(self):
        instances = []

        def server(address, _handler):
            instance = SimpleNamespace(server_address=('127.0.0.1', address[1] or 19000 + len(instances)), server_close=Mock())
            instances.append(instance)
            return instance

        with patch('tools.demo_server.ThreadingHTTPServer', side_effect=server):
            servers = create_servers(self.state, 8082)
        self.assertEqual(len(servers), 5)
        origins = self.state.transport['emageOrigins'] + self.state.transport['pngOrigins']
        self.assertEqual(len(set(origins)), 4)
        self.assertNotIn('http://localhost:8082', origins)
        self.assertFalse(servers[0].transport_only)
        self.assertTrue(all(item.transport_only for item in servers[1:]))
        self.assertIs(servers[1].state.bucket('slow', '12345678', 'gallery-emage'), servers[2].state.bucket('slow', '12345678', 'gallery-emage'))
        self.assertIsNot(servers[1].state.bucket('slow', '12345678', 'gallery-emage'), servers[3].state.bucket('slow', '12345678', 'gallery-png'))

    def test_pages_origin_is_only_used_for_cors_in_controls_only_mode(self):
        with patch('tools.demo_server.ThreadingHTTPServer', side_effect=lambda address, handler:
                   SimpleNamespace(server_address=address, server_close=Mock())):
            create_servers(self.state, 8082, bind='0.0.0.0',
                           public_origin='https://autovizz.github.io',
                           transport_ports=[3434, 3435, 3436, 3437], controls_only=True)
        self.assertEqual(self.state.allowed_origins, {'https://autovizz.github.io'})
        self.assertEqual(self.state.transport['emageOrigins'], ['http://localhost:3434', 'http://localhost:3435'])
        self.assertEqual(self.state.transport['pngOrigins'], ['http://localhost:3436', 'http://localhost:3437'])

    def test_docker_listeners_advertise_public_origins_and_allow_site_cors(self):
        instances = []

        def server(address, _handler):
            instance = SimpleNamespace(server_address=address, server_close=Mock())
            instances.append(instance)
            return instance

        with patch('tools.demo_server.ThreadingHTTPServer', side_effect=server):
            servers = create_servers(self.state, 8082, bind='0.0.0.0',
                                     public_origin='http://localhost:3433',
                                     transport_ports=[3434, 3435, 3436, 3437])
        self.assertEqual([item.server_address for item in servers],
                         [('0.0.0.0', port) for port in [8082, 3434, 3435, 3436, 3437]])
        self.assertEqual(self.state.transport['emageOrigins'], ['http://localhost:3434', 'http://localhost:3435'])
        self.assertEqual(self.state.transport['pngOrigins'], ['http://localhost:3436', 'http://localhost:3437'])
        self.assertEqual(self.state.allowed_origins, {'http://localhost:3433', 'http://127.0.0.1:3433'})
        handler = self.handler()
        handler.headers['Origin'] = 'http://localhost:3433'
        with patch('tools.demo_server.SimpleHTTPRequestHandler.end_headers'):
            DemoHandler.end_headers(handler)
        self.assertEqual(handler.sent_headers['Access-Control-Allow-Origin'], 'http://localhost:3433')

    def test_tls_transport_origins_can_differ_from_internal_listeners(self):
        origins = ['https://e1.example', 'https://e2.example', 'https://p1.example', 'https://p2.example']
        def server(address, _handler):
            return SimpleNamespace(server_address=address, server_close=Mock())
        with patch('tools.demo_server.ThreadingHTTPServer', side_effect=server):
            create_servers(self.state, 8082, bind='0.0.0.0', public_origin='https://site.example',
                           transport_ports=[3434, 3435, 3436, 3437], transport_origins=origins)
        self.assertEqual(self.state.transport['emageOrigins'] + self.state.transport['pngOrigins'], origins)
        self.assertEqual(self.state.allowed_origins, {'https://site.example'})

    def test_invalid_public_network_settings_fail_before_binding(self):
        invalid = [dict(transport_ports=[3434, 3434, 3436, 3437]),
                   dict(transport_ports=[3434, 3435]),
                   dict(public_origin='http://user:secret@host'),
                   dict(public_origin='https://host/path'),
                   dict(transport_origins=['https://one.example'] * 4)]
        for options in invalid:
            with self.subTest(options=options), patch('tools.demo_server.ThreadingHTTPServer') as server:
                with self.assertRaises(ValueError):
                    create_servers(self.state, 8082, **options)
                server.assert_not_called()

    def test_seed_retries_api_startup_and_stops_after_success(self):
        with patch('tools.demo_server.seed', side_effect=[RuntimeError('API unavailable'), None]) as seed, \
                patch('tools.demo_server.time.sleep') as sleep:
            seed_with_retry(self.state, attempts=3)
        self.assertEqual(seed.call_count, 2)
        sleep.assert_called_once_with(2)

    def test_failed_transport_start_closes_all_allocated_ports(self):
        instances = []

        def server(address, _handler):
            if len(instances) == 2:
                raise OSError('No available transport port')
            instance = SimpleNamespace(server_address=('127.0.0.1', address[1] or 19000), server_close=Mock())
            instances.append(instance)
            return instance

        with patch('tools.demo_server.ThreadingHTTPServer', side_effect=server), self.assertRaises(OSError):
            create_servers(self.state, 8082)
        for instance in instances:
            instance.server_close.assert_called_once()

    def test_cors_preflight_and_timing_headers_allow_only_the_page_origin(self):
        handler = self.handler()
        handler.path = '/demo/net/slow/12345678/gallery-emage/api/image/' + self.state.manifest['images'][0]['serverPath']
        self.state.allowed_origins = {'http://localhost:8082'}
        handler.headers['Origin'] = 'http://localhost:8082'
        handler.do_OPTIONS()
        self.assertEqual(handler.status, 204)
        self.assertEqual(handler.sent_headers['Access-Control-Allow-Headers'], 'X-Emage-Layers')
        with patch('tools.demo_server.SimpleHTTPRequestHandler.end_headers'):
            DemoHandler.end_headers(handler)
        self.assertEqual(handler.sent_headers['Access-Control-Allow-Origin'], 'http://localhost:8082')
        self.assertEqual(handler.sent_headers['Timing-Allow-Origin'], 'http://localhost:8082')
        self.assertIn('X-Emage-TilePsotOffsets', handler.sent_headers['Access-Control-Expose-Headers'])
        handler.headers['Origin'] = 'https://other.invalid'
        handler.do_OPTIONS()
        self.assertEqual(handler.status, 403)

    def test_stop_interrupts_a_reserved_bandwidth_wait_across_origins(self):
        entered = threading.Event()

        class InterruptibleEvent(threading.Event):
            def wait(self, delay):
                entered.set()
                return super().wait(delay)

        cancelled = InterruptibleEvent()
        self.state.runs['12345678'] = (cancelled, __import__('time').monotonic())
        bandwidth = self.state.bucket('slow', '12345678', 'gallery-png')
        result = []

        def charge():
            try:
                bandwidth.charge(100000000)
            except TransferCancelled:
                result.append('stopped')

        thread = threading.Thread(target=charge, daemon=True)
        thread.start()
        self.assertTrue(entered.wait(1))
        self.state.cancel('12345678')
        thread.join(1)
        self.assertFalse(thread.is_alive())
        self.assertEqual(result, ['stopped'])
        self.assertTrue(self.state.bucket('slow', '12345678', 'gallery-emage').cancelled.is_set())

    def test_transport_listeners_do_not_serve_static_pages_or_head_requests(self):
        handler = self.handler()
        handler.server.transport_only = True
        handler.path = '/blog.html'
        handler.do_GET()
        self.assertEqual(handler.status, 404)
        handler.send_error = Mock()
        handler.do_HEAD()
        handler.send_error.assert_called_once_with(405)

    def test_stop_route_only_cancels_the_local_run_and_never_forwards_to_api(self):
        handler = self.handler()
        handler.path = '/demo/cancel/12345678'
        with patch('tools.demo_server.urlopen') as upstream:
            handler.do_POST()
            upstream.assert_not_called()
        self.assertEqual(handler.status, 200)
        self.assertTrue(self.state.run_event('12345678').is_set())


if __name__ == '__main__':
    unittest.main()
