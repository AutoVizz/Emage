import io
import json
import subprocess
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch, MagicMock

from tools.deployment_admin import AdminHandler, Deployment, SERVICES, main


class AdminTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.deployment = Deployment(self.directory.name, 'test-project', 'test-password', 'http://localhost:3433')

    def handler(self, path='/admin/api/rebuild', body=None, origin='http://localhost:3433'):
        handler = object.__new__(AdminHandler)
        handler.server = SimpleNamespace(deployment=self.deployment)
        handler.path = path
        data = json.dumps(body or {}).encode()
        handler.rfile, handler.wfile = io.BytesIO(data), io.BytesIO()
        handler.headers = {'Content-Length': str(len(data)), 'Origin': origin}
        handler.send_response = lambda status: setattr(handler, 'status', status)
        handler.send_header = Mock()
        handler.end_headers = Mock()
        return handler

    def test_controller_uses_the_upload_password(self):
        with patch.dict('os.environ', {'ADMIN_PROJECT_DIR': '/deployment',
                'ADMIN_PROJECT_NAME': 'test-project', 'EMAGE_UPLOAD_PASSWORD': 'upload-secret'}, clear=True), \
                patch('tools.deployment_admin.ThreadingHTTPServer') as http_server, \
                patch('tools.deployment_admin.threading.Thread'), \
                patch('tools.deployment_admin.logging.basicConfig'):
            main()
        self.assertEqual(http_server.return_value.deployment.password, 'upload-secret')

    def test_wrong_password_never_enqueues_a_rebuild(self):
        self.deployment.request = Mock()
        handler = self.handler(body={'password': 'wrong'})
        handler.do_POST()
        self.assertEqual(handler.status, 401)
        self.deployment.request.assert_not_called()

    def test_correct_password_enqueues_whole_stack_job_without_echoing_password(self):
        self.deployment.request = Mock(return_value={'id': 'id', 'token': 'job-token', 'state': 'queued'})
        handler = self.handler(body={'password': 'test-password'})
        handler.do_POST()
        self.assertEqual(handler.status, 202)
        self.deployment.request.assert_called_once()
        self.assertNotIn(b'test-password', handler.wfile.getvalue())

    def test_auto_origin_accepts_only_the_http_page_host(self):
        self.deployment.infer_origin = True
        self.deployment.request = Mock(return_value={'state': 'queued'})
        handler = self.handler(body={'password': 'test-password'}, origin='http://192.0.2.10:3433')
        handler.headers['Host'] = '192.0.2.10:3433'
        handler.do_POST()
        self.assertEqual(handler.status, 202)
        handler = self.handler(body={'password': 'test-password'}, origin='http://other.example:3433')
        handler.headers['Host'] = '192.0.2.10:3433'
        handler.do_POST()
        self.assertEqual(handler.status, 403)

    def test_https_admin_accepts_matching_origin_behind_nginx(self):
        self.deployment.infer_origin = True
        self.deployment.request = Mock(return_value={'state': 'queued'})
        handler = self.handler(body={'password': 'test-password'}, origin='https://emage.gqvz.xyz')
        handler.headers['Host'] = 'emage.gqvz.xyz'
        handler.headers['X-Forwarded-Proto'] = 'https'
        handler.do_POST()
        self.assertEqual(handler.status, 202)

    def test_missing_or_foreign_origins_cannot_request_a_rebuild(self):
        self.deployment.request = Mock()
        for origin in [None, 'https://foreign.example']:
            handler = self.handler(body={'password': 'test-password'}, origin=origin)
            handler.do_POST()
            self.assertEqual(handler.status, 403)
        self.deployment.request.assert_not_called()

    def test_password_attempts_are_limited_and_empty_configuration_is_disabled(self):
        for _ in range(5):
            self.assertEqual(self.deployment.authenticate('wrong'), 401)
        self.assertEqual(self.deployment.authenticate('test-password'), 429)
        self.deployment.password = ''
        self.deployment.failed_logins.clear()
        self.assertEqual(self.deployment.authenticate(''), 503)

    def test_job_status_requires_the_returned_token(self):
        self.deployment.job = {'id': 'id', 'token': 'secret-token', 'state': 'building'}
        handler = self.handler(path='/admin/api/status')
        handler.do_GET()
        self.assertEqual(handler.status, 401)
        handler = self.handler(path='/admin/api/status')
        handler.headers['X-Emage-Job-Token'] = 'secret-token'
        handler.headers['Authorization'] = 'Basic browser-site-credentials'
        handler.do_GET()
        self.assertEqual(handler.status, 200)
        self.assertNotIn('token', json.loads(handler.wfile.getvalue()))

    def test_only_one_rebuild_runs_and_automatic_retries_have_a_cooldown(self):
        with patch('tools.deployment_admin.threading.Thread') as thread:
            first = self.deployment.request('manual')
            second = self.deployment.request('manual')
            self.assertEqual(first['id'], second['id'])
            thread.assert_called_once()
            self.deployment.active = False
            self.assertIsNone(self.deployment.request('unhealthy', automatic=True))
            self.deployment.request('manual retry')
            self.assertEqual(thread.call_count, 2)

    def test_real_health_failure_enqueues_rebuild_after_startup(self):
        self.deployment.failures = Mock(return_value=[])
        self.deployment.request = Mock()
        self.deployment.check_health()
        self.assertTrue(self.deployment.observed_healthy)
        self.deployment.failures.return_value = ['demo']
        self.deployment.check_health()
        self.deployment.request.assert_called_once_with('Health check failed: demo', automatic=True)

    def test_startup_and_active_builds_do_not_cause_rebuild_loops(self):
        self.deployment.failures = Mock(return_value=['demo'])
        self.deployment.request = Mock()
        self.deployment.check_health()
        self.deployment.active = True
        self.deployment.observed_healthy = True
        self.deployment.check_health()
        self.deployment.request.assert_not_called()

    def test_git_refs_are_resolved_anonymously_without_deployment_credentials(self):
        (Path(self.directory.name) / '.env').write_text('EMAGE_UPLOAD_PASSWORD=test-password\n')
        commits = ['a' * 40, 'b' * 40, 'c' * 40]
        calls = []
        def remote(command, **options):
            self.assertIn('credential.helper=', command)
            self.assertEqual(options['env']['GIT_TERMINAL_PROMPT'], '0')
            self.assertNotIn('GIT_ASKPASS', options['env'])
            self.assertNotIn('GITHUB_TOKEN', options['env'])
            calls.append(command)
            return commits[len(calls) - 1] + '\trefs/heads/main\n'
        with patch('tools.deployment_admin.subprocess.check_output', side_effect=remote):
            refs = self.deployment.resolve_refs()
        self.assertEqual(list(refs.values()), commits)
        self.assertEqual(len(calls), 3)

    def prepare_rebuild(self):
        self.deployment.job = {'token': 'token', 'state': 'queued'}
        self.deployment.active = True
        self.deployment.containers = Mock(return_value={name: {'Image': 'sha256:old-' + name} for name in SERVICES})
        self.deployment.resolve_refs = Mock(return_value={'SERVER_REF': 'a' * 40, 'WASM_REF': 'b' * 40, 'CLIENT_REF': 'c' * 40})
        self.deployment.failures = Mock(return_value=[])
        self.deployment.wait_ready = Mock()

    def test_build_finishes_before_any_running_service_is_replaced(self):
        self.prepare_rebuild()
        with patch('tools.deployment_admin.subprocess.run') as run:
            self.deployment.rebuild()
        commands = [call.args[0] for call in run.call_args_list]
        self.assertIn('build', commands[0])
        self.assertIn('up', commands[1])
        self.assertNotIn('admin', commands[1])
        self.assertEqual(commands[1][-3:], ['server', 'client', 'demo'])
        self.assertIn('client', commands[0])
        self.assertEqual(self.deployment.job['state'], 'succeeded')
        self.assertFalse(self.deployment.active)

    def test_failed_build_preserves_running_containers(self):
        self.prepare_rebuild()
        with patch('tools.deployment_admin.subprocess.run', side_effect=subprocess.CalledProcessError(1, ['docker', 'compose', 'build'])) as run, \
                self.assertLogs('deployment', level='ERROR'):
            self.deployment.rebuild()
        self.assertEqual(run.call_count, 1)
        self.assertEqual(self.deployment.job['state'], 'failed')
        self.deployment.wait_ready.assert_not_called()

    def test_failed_rollout_restores_previous_images(self):
        self.prepare_rebuild()
        self.deployment.wait_ready.side_effect = [RuntimeError('not ready'), None]
        commands = []
        def execute(command, **kwargs):
            commands.append(command)
            if len(commands) == 3:
                files = [command[index + 1] for index, item in enumerate(command) if item == '-f']
                override = json.loads(Path(files[-1]).read_text())
                self.assertEqual(override['services']['server']['image'], 'sha256:old-server')
                self.assertEqual(override['services']['demo']['pull_policy'], 'never')
        with patch('tools.deployment_admin.subprocess.run', side_effect=execute), self.assertLogs('deployment', level='ERROR'):
            self.deployment.rebuild()
        self.assertEqual(len(commands), 3)
        self.assertEqual(self.deployment.wait_ready.call_count, 2)
        self.assertIn('restored', self.deployment.job['message'])
        self.assertEqual(self.deployment.job['state'], 'failed')

    def test_admin_ui_is_served_by_the_backend_only(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'admin.html').write_text('<html>Upload password</html>')
            with patch('tools.deployment_admin.ADMIN_ROOT', root):
                handler = self.handler(path='/admin')
                handler.do_GET()
                self.assertEqual(handler.status, 200)
                self.assertIn(b'Upload password', handler.wfile.getvalue())
                handler = self.handler(path='/.env')
                handler.do_GET()
                self.assertEqual(handler.status, 404)

    def test_no_public_health_or_legacy_admin_route(self):
        for path in ['/health', '/healthCheck']:
            handler = self.handler(path=path)
            handler.do_GET()
            self.assertEqual(handler.status, 404)


if __name__ == '__main__':
    unittest.main()
