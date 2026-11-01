import io
import unittest
from types import SimpleNamespace
from unittest.mock import patch
from urllib.parse import urlencode

from tools.client_auth import COOKIE, LoginHandler, Sessions, local_path


class ClientAuthTests(unittest.TestCase):
    def test_cookies_require_a_valid_signature_and_expire(self):
        sessions = Sessions('site-password')
        token = sessions.issue()
        self.assertTrue(sessions.valid(f'{COOKIE}={token}'))
        self.assertFalse(sessions.valid(f'{COOKIE}={token[:-1]}x'))
        self.assertFalse(sessions.valid(''))
        self.assertFalse(Sessions('site-password').valid(f'{COOKIE}={token}'))
        with patch('tools.client_auth.time.time', return_value=10**12):
            self.assertFalse(sessions.valid(f'{COOKIE}={token}'))

    def test_redirects_stay_on_the_site(self):
        for path in ['//evil.test', 'https://evil.test', '/\\evil.test', '/\t/evil.test', '/\r\nLocation:evil', '/login']:
            self.assertEqual(local_path(path), '/')
        self.assertEqual(local_path('/blog.html?tab=demo'), '/blog.html?tab=demo')

    def test_wrong_password_attempts_are_limited(self):
        sessions = Sessions('site-password')
        for _ in range(10):
            self.assertEqual(sessions.authenticate('wrong'), 401)
        self.assertEqual(sessions.authenticate('site-password'), 429)

    def test_password_only_form_and_session(self):
        sessions = Sessions('site-password')
        def request(path, body=None, headers=None):
            handler = object.__new__(LoginHandler)
            handler.server = SimpleNamespace(sessions=sessions)
            handler.path = path
            data = urlencode(body).encode() if body is not None else b''
            handler.rfile, handler.wfile = io.BytesIO(data), io.BytesIO()
            handler.headers = {'Content-Length': str(len(data)), **(headers or {})}
            handler.response_headers = {}
            handler.send_response = lambda status: setattr(handler, 'status', status)
            handler.send_header = lambda key, value: handler.response_headers.update({key: value})
            handler.end_headers = lambda: None
            (handler.do_GET if body is None else handler.do_POST)()
            return handler
        response = request('/login', headers={'X-Original-URI': '/blog.html'})
        page = response.wfile.getvalue()
        self.assertIn(b'name="password"', page)
        self.assertNotIn(b'username', page)
        self.assertIn(b'value="/blog.html"', page)
        self.assertEqual(request('/verify').status, 401)
        response = request('/login', {'password': 'wrong'})
        self.assertEqual(response.status, 401)
        self.assertNotIn('Set-Cookie', response.response_headers)
        response = request('/login', {'password': 'site-password', 'next': '/blog.html'})
        self.assertEqual(response.status, 303)
        self.assertEqual(response.response_headers['Location'], '/blog.html')
        cookie = response.response_headers['Set-Cookie']
        self.assertIn('HttpOnly', cookie)
        self.assertIn('SameSite=Lax', cookie)
        self.assertEqual(request('/verify', headers={'Cookie': cookie}).status, 204)
