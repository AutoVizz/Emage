#!/usr/bin/env python3
"""Assemble the public static client, excluding backend code and credentials."""
import argparse
import json
import os
from pathlib import Path
import shutil
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parents[1]
PAGES = ('index.html', 'uploader.html', 'downloader.html', 'compare.html', 'blog.html',
         'docs.html', 'running-locally.html', 'protocol.html', 'resolution-keys.html',
         'experiment-methodology.html')
SCRIPTS = ('theme.js', 'common.js', 'uploader.js', 'downloader.js', 'compare.js', 'blog.js')
CODECS = ('EmageWasmEncoder.js', 'EmageWasmEncoder.wasm', 'EmageWasmDecoder.js', 'EmageWasmDecoder.wasm')


def public_url(value, default=''):
    value = value.strip() or default
    if not value:
        return ''
    parsed = urlsplit(value)
    if parsed.scheme not in ('http', 'https') or not parsed.netloc or parsed.username or parsed.password or parsed.query or parsed.fragment:
        raise ValueError('Public service URLs must be HTTP(S) addresses without credentials, query or fragment.')
    return value.rstrip('/')


def build(output, wasm, api_url='', demo_url='', source=ROOT):
    output, wasm, source = Path(output).resolve(), Path(wasm).resolve(), Path(source).resolve()
    if output == source or source.is_relative_to(output) or wasm == output or wasm.is_relative_to(output):
        raise ValueError('Output must be separate from the source and codec directories.')
    settings = {'apiUrl': public_url(api_url), 'demoUrl': public_url(demo_url)}
    for name in CODECS:
        path = wasm / name
        if not path.is_file() or path.is_symlink():
            raise ValueError(f'Build the WASM codecs first: missing {name}.')
        if name.endswith('.wasm') and path.read_bytes()[:4] != b'\x00asm':
            raise ValueError(f'{name} is not a WebAssembly module.')
    if output.exists():
        shutil.rmtree(output)
    output.mkdir(parents=True)

    def copy(path, relative):
        if path.is_symlink():
            raise ValueError(f'Symbolic links are not allowed in the public site: {relative}')
        target = output / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(path, target)

    for name in (*PAGES, 'emage.js', 'vendor/noble-sha3.js'):
        copy(source / name, name)
    for name in SCRIPTS:
        copy(source / 'js' / name, 'js/' + name)
    for directory, suffixes in {
        'css': {'.css'},
        'assets': {'.png', '.jpg', '.jpeg', '.svg', '.ico', '.webp', '.woff', '.woff2'},
        'demo-assets': {'.png', '.j2k', '.json'},
    }.items():
        for path in sorted((source / directory).rglob('*')):
            if path.is_file() and path.suffix.lower() in suffixes and not any(part.startswith('.') for part in path.relative_to(source).parts):
                copy(path, path.relative_to(source))
    for name in CODECS:
        copy(wasm / name, 'wasm/' + name)
    (output / 'js' / 'config.js').write_text('export const siteConfig = Object.freeze(' + json.dumps(settings) + ');\n')
    (output / '.nojekyll').touch()
    return output


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', default='_site')
    parser.add_argument('--wasm-dir', default='wasm')
    args = parser.parse_args()
    build(args.output, args.wasm_dir, os.environ.get('EMAGE_API_URL', ''), os.environ.get('EMAGE_DEMO_URL', ''))
    print(f'Built static client in {args.output}.')


if __name__ == '__main__':
    main()
