#!/usr/bin/env python3
"""Password-protected deployment control, isolated from the application services."""
import hmac
import json
import logging
import os
from pathlib import Path
import re
import secrets
import subprocess
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit
from urllib.request import urlopen

LOG = logging.getLogger('deployment')
SERVICES = ('server', 'demo')
BUILD_SERVICES = ('server', 'demo')
REPOSITORIES = {'SERVER_REF': 'Emage-Server', 'CLIENT_REF': 'Emage'}
ADMIN_FILES = {
    '/': ('admin.html', 'text/html; charset=utf-8'),
    '/admin': ('admin.html', 'text/html; charset=utf-8'),
    '/js/admin.js': ('js/admin.js', 'text/javascript; charset=utf-8'),
    '/js/theme.js': ('js/theme.js', 'text/javascript; charset=utf-8'),
    '/css/theme.css': ('css/theme.css', 'text/css; charset=utf-8'),
    '/css/blog.css': ('css/blog.css', 'text/css; charset=utf-8'),
}
ADMIN_ROOT = Path('/usr/share/emage-admin')


def read_env(path):
    values = {}
    for line in Path(path).read_text().splitlines():
        line = line.strip()
        if not line or line.startswith('#') or '=' not in line:
            continue
        key, value = line.split('=', 1)
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in ('"', "'"):
            value = value[1:-1]
        values[key.strip()] = value
    return values


class Deployment:
    def __init__(self, directory, project, password, public_origin, cooldown=300, grace=180):
        self.directory = Path(directory)
        self.project = project
        self.password = password
        self.origins = {public_origin.rstrip('/')}
        parsed = urlsplit(public_origin)
        if parsed.hostname in ('localhost', '127.0.0.1'):
            suffix = f':{parsed.port}' if parsed.port else ''
            self.origins.update(f'{parsed.scheme}://{host}{suffix}' for host in ('localhost', '127.0.0.1'))
        self.lock = threading.RLock()
        self.job = None
        self.active = False
        self.last_attempt = float('-inf')
        self.started = time.monotonic()
        self.observed_healthy = False
        self.cooldown, self.grace = cooldown, grace
        self.failed_logins = []

    def authenticate(self, supplied):
        with self.lock:
            now = time.monotonic()
            self.failed_logins = [stamp for stamp in self.failed_logins if now - stamp < 60]
            if len(self.failed_logins) >= 5:
                return 429
            if not self.password:
                return 503
            if not isinstance(supplied, str) or not hmac.compare_digest(supplied.encode(), self.password.encode()):
                self.failed_logins.append(now)
                return 401
            return 200

    def compose(self, *args, override=None):
        command = ['docker', 'compose', '--project-directory', str(self.directory),
                   '--env-file', str(self.directory / '.env'), '-p', self.project,
                   '-f', str(self.directory / 'compose.yaml')]
        if override:
            command += ['-f', str(override)]
        return command + list(args)

    def containers(self):
        ids = subprocess.check_output(['docker', 'ps', '-aq', '--filter',
                f'label=com.docker.compose.project={self.project}'], text=True, timeout=15).split()
        if not ids:
            return {}
        items = json.loads(subprocess.check_output(['docker', 'inspect', *ids], text=True, timeout=15))
        return {item['Config']['Labels']['com.docker.compose.service']: item for item in items
                if item['Config']['Labels'].get('com.docker.compose.service') in SERVICES}

    def failures(self, require_ready=False):
        containers = self.containers()
        failures = []
        for name in SERVICES:
            state = containers.get(name, {}).get('State', {})
            health = state.get('Health', {}).get('Status')
            if not state.get('Running') or state.get('Restarting') or health == 'unhealthy':
                failures.append(name)
            elif require_ready and health == 'starting':
                failures.append(name)
        # Probe the actual API too, without adding a public health endpoint.
        if 'server' not in failures:
            try:
                with urlopen('http://server:3233/images', timeout=3) as response:
                    if response.status != 200:
                        failures.append('server')
            except OSError:
                failures.append('server')
        return failures

    def resolve_refs(self):
        settings = read_env(self.directory / '.env')
        settings.update({key: os.environ[key] for key in ('GITHUB_OWNER', *REPOSITORIES) if key in os.environ})
        token = settings.get('GITHUB_TOKEN', '')
        if not token:
            raise RuntimeError('Set GITHUB_TOKEN in the deployment .env file.')
        owner = settings.get('GITHUB_OWNER', 'AutoVizz')
        if not re.fullmatch(r'[A-Za-z0-9-]+', owner):
            raise RuntimeError('Invalid GITHUB_OWNER.')
        resolved = {}
        with tempfile.TemporaryDirectory(prefix='emage-git-') as directory:
            secret = Path(directory) / 'token'
            secret.write_text(token)
            secret.chmod(0o600)
            helper = Path(directory) / 'askpass'
            helper.write_text('#!/bin/sh\ncase "$1" in\n*Username*) printf "%s\\n" x-access-token;;\n*Password*) cat "$EMAGE_GIT_TOKEN_FILE";;\nesac\n')
            helper.chmod(0o700)
            env = {**os.environ, 'GIT_ASKPASS': str(helper), 'GIT_TERMINAL_PROMPT': '0',
                   'EMAGE_GIT_TOKEN_FILE': str(secret)}
            for key, repository in REPOSITORIES.items():
                ref = settings.get(key, 'main')
                if re.fullmatch(r'[a-fA-F0-9]{40}', ref):
                    resolved[key] = ref
                    continue
                patterns = [ref, ref + '^{}'] if ref.startswith('refs/') else [
                    'refs/heads/' + ref, 'refs/tags/' + ref, 'refs/tags/' + ref + '^{}']
                output = subprocess.check_output(['git', '-c', 'credential.helper=', 'ls-remote',
                    f'https://github.com/{owner}/{repository}.git', *patterns],
                    env=env, text=True, stderr=subprocess.DEVNULL, timeout=45)
                refs = dict((name, commit) for commit, name in (line.split() for line in output.splitlines()))
                commit = refs.get('refs/heads/' + ref) or refs.get('refs/tags/' + ref + '^{}') or refs.get('refs/tags/' + ref) or refs.get(ref + '^{}') or refs.get(ref)
                if not commit:
                    raise RuntimeError(f'Cannot resolve {repository} ref {ref}.')
                resolved[key] = commit
        return resolved

    def progress(self, state, message):
        with self.lock:
            self.job.update(state=state, message=message)
        LOG.info('%s: %s', state, message)

    def request(self, reason, automatic=False):
        with self.lock:
            if self.active:
                return dict(self.job)
            now = time.monotonic()
            if automatic and now - self.last_attempt < self.cooldown:
                return None
            self.active = True
            self.last_attempt = now
            self.job = {'id': secrets.token_hex(8), 'token': secrets.token_urlsafe(32),
                        'state': 'queued', 'message': 'Rebuild queued.', 'reason': reason}
            job = dict(self.job)
        LOG.info('Rebuild requested: %s', reason)
        threading.Thread(target=self.rebuild, daemon=True).start()
        return job

    def status(self, token):
        with self.lock:
            if not self.job or not token or not hmac.compare_digest(token, self.job['token']):
                return None
            return {key: value for key, value in self.job.items() if key != 'token'}

    def wait_ready(self, timeout=180):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if not self.failures(require_ready=True):
                return
            time.sleep(3)
        raise RuntimeError('The deployed services did not become healthy.')

    def rebuild(self):
        previous = {}
        deployed = False
        try:
            previous = {name: container['Image'] for name, container in self.containers().items()}
            self.progress('resolving', 'Resolving the configured GitHub branches.')
            refs = self.resolve_refs()
            args = [argument for key, commit in refs.items() for argument in ('--build-arg', f'{key}={commit}')]
            self.progress('building', 'Building the server and blog proxy. Current backend services stay running.')
            subprocess.run(self.compose('build', *args, *BUILD_SERVICES), check=True, timeout=3600)
            self.progress('deploying', 'Starting the rebuilt application services.')
            targets = list(SERVICES)
            deployed = True
            subprocess.run(self.compose('up', '-d', '--no-build', '--no-deps', '--force-recreate', *targets), check=True, timeout=180)
            self.progress('verifying', 'Checking the new services.')
            self.wait_ready()
            self.progress('succeeded', 'The backend is updated and healthy. The client deploys independently through GitHub Pages.')
        except Exception:
            LOG.exception('Deployment failed')
            if deployed and previous:
                try:
                    self.progress('rolling_back', 'The new deployment failed. Restoring the previous images.')
                    with tempfile.TemporaryDirectory(prefix='emage-rollback-') as directory:
                        override = Path(directory) / 'compose.json'
                        override.write_text(json.dumps({'services': {name: {'image': image, 'pull_policy': 'never'} for name, image in previous.items()}}))
                        subprocess.run(self.compose('up', '-d', '--no-build', '--no-deps', '--force-recreate', *previous, override=override), check=True, timeout=180)
                        self.wait_ready()
                    self.progress('failed', 'Deployment failed; the previous images were restored. Check the admin service logs.')
                except Exception:
                    LOG.exception('Rollback failed')
                    self.progress('failed', 'Deployment and recovery failed. Check the admin service logs.')
            else:
                self.progress('failed', 'Build failed; the current deployment was kept. Check the admin service logs.')
        finally:
            with self.lock:
                self.active = False

    def check_health(self):
        with self.lock:
            if self.active:
                return
        failures = self.failures()
        if not failures:
            self.observed_healthy = True
        elif self.observed_healthy or time.monotonic() - self.started >= self.grace:
            self.request('Health check failed: ' + ', '.join(failures), automatic=True)

    def monitor(self):
        while True:
            try:
                self.check_health()
            except Exception:
                LOG.exception('Health monitoring failed')
            time.sleep(10)


class AdminHandler(BaseHTTPRequestHandler):
    def log_message(self, message, *args):
        # Do not log request bodies, passwords, headers or status tokens.
        LOG.info('%s %s', self.command, self.path.split('?')[0])

    def respond(self, status, body):
        content = json.dumps(body).encode()
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Cache-Control', 'no-store')
        self.send_header('Content-Length', str(len(content)))
        self.end_headers()
        self.wfile.write(content)

    def do_GET(self):
        path = urlsplit(self.path).path
        if path == '/ready':
            return self.respond(200, {'ready': True})
        if path in ADMIN_FILES:
            relative, content_type = ADMIN_FILES[path]
            file = ADMIN_ROOT / relative
            if not file.is_file():
                return self.respond(404, {'error': 'Not found.'})
            content = file.read_bytes()
            self.send_response(200)
            self.send_header('Content-Type', content_type)
            self.send_header('Content-Length', str(len(content)))
            self.end_headers()
            return self.wfile.write(content)
        if path != '/admin/api/status':
            return self.respond(404, {'error': 'Not found.'})
        token = self.headers.get('X-Emage-Job-Token', '')
        status = self.server.deployment.status(token)
        return self.respond(200, status) if status else self.respond(401, {'error': 'Authentication required.'})

    def do_POST(self):
        deployment = self.server.deployment
        if urlsplit(self.path).path != '/admin/api/rebuild':
            return self.respond(404, {'error': 'Not found.'})
        if self.headers.get('Origin') not in deployment.origins:
            return self.respond(403, {'error': 'Origin not allowed.'})
        try:
            length = int(self.headers.get('Content-Length', '0'))
            if not 0 < length <= 4096:
                return self.respond(400, {'error': 'Invalid request.'})
            body = json.loads(self.rfile.read(length))
            if not isinstance(body, dict):
                return self.respond(400, {'error': 'Invalid request.'})
        except (ValueError, UnicodeError):
            return self.respond(400, {'error': 'Invalid request.'})
        status = deployment.authenticate(body.get('password'))
        if status != 200:
            messages = {401: 'Incorrect upload password.', 429: 'Too many attempts. Try again in one minute.', 503: 'The upload password is not configured.'}
            return self.respond(status, {'error': messages[status]})
        job = deployment.request('Requested from the admin page.')
        return self.respond(202, job)


def main():
    logging.basicConfig(level=logging.INFO, format='%(asctime)s %(message)s')
    directory = os.environ['ADMIN_PROJECT_DIR']
    project = os.environ['ADMIN_PROJECT_NAME']
    deployment = Deployment(directory, project, os.environ.get('EMAGE_UPLOAD_PASSWORD', ''),
        os.environ.get('ADMIN_PUBLIC_ORIGIN', 'http://localhost:3433'),
        cooldown=int(os.environ.get('ADMIN_REBUILD_COOLDOWN', '300')),
        grace=int(os.environ.get('ADMIN_STARTUP_GRACE', '180')))
    server = ThreadingHTTPServer(('0.0.0.0', 8080), AdminHandler)
    server.daemon_threads = True
    server.deployment = deployment
    threading.Thread(target=deployment.monitor, daemon=True).start()
    server.serve_forever()


if __name__ == '__main__':
    main()
