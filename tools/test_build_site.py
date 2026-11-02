import json
from pathlib import Path
import tempfile
import unittest

from tools.build_site import ROOT, CODECS, build


class SiteBuildTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.work = Path(self.directory.name)
        self.wasm = self.work / 'wasm'
        self.wasm.mkdir()
        for name in CODECS:
            (self.wasm / name).write_bytes(b'\x00asm' if name.endswith('.wasm') else b'// codec factory')

    def test_public_artifact_excludes_backend_and_credentials(self):
        output = build(self.work / 'site', self.wasm, 'https://api.example/emage', 'https://demo.example')
        self.assertTrue((output / 'downloader.html').is_file())
        self.assertTrue((output / 'wasm/EmageWasmDecoder.wasm').is_file())
        self.assertTrue((output / '.nojekyll').is_file())
        for name in ('admin.html', 'js/admin.js', '.env', '.env.example', 'Dockerfile', 'tools', '.git', '.github'):
            self.assertFalse((output / name).exists(), name)
        config = (output / 'js/config.js').read_text()
        self.assertIn('https://api.example/emage', config)
        self.assertNotIn('TOKEN', config)
        self.assertNotIn('PASSWORD', config)

    def test_rejects_credentials_and_non_service_addresses(self):
        for value in ('https://user:secret@example.com', 'file:///etc/passwd', 'https://api.example?password=secret', 'https://api.example/#secret'):
            with self.assertRaises(ValueError):
                build(self.work / 'site', self.wasm, value)

    def test_requires_real_codec_outputs(self):
        (self.wasm / CODECS[1]).write_text('not a WASM file')
        with self.assertRaises(ValueError):
            build(self.work / 'site', self.wasm)

    def test_does_not_overwrite_source_tree(self):
        with self.assertRaises(ValueError):
            build(ROOT, self.wasm)
        with self.assertRaises(ValueError):
            build(self.work, self.wasm)
