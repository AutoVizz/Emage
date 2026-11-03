import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const { JSDOM } = createRequire(import.meta.url)('jsdom');
const root = new URL('./', import.meta.url);
const origin = 'http://emage.test/';
const pages = ['blog.html', 'docs.html', 'running-locally.html', 'protocol.html', 'resolution-keys.html', 'experiment-methodology.html'];
const documents = new Map();
function documentFor(path) {
  if (!documents.has(path)) documents.set(path, new JSDOM(readFileSync(new URL(path.slice(1), root), 'utf8')).window.document);
  return documents.get(path);
}
const linkedArticles = new Set();
for (const page of pages) {
  const document = documentFor('/' + page);
  assert.equal(document.querySelectorAll('h1').length, 1, page + ' has one article title');
  assert.ok(document.querySelector('meta[name="description"]')?.content, page + ' has a description');
  assert.ok(document.querySelector('head script[src="js/theme.js"]:not([defer]):not([async])'), page + ' applies its theme before paint');
  assert.ok(document.querySelector('.masthead [data-theme-select]'), page + ' has a theme control');
  const ids = [...document.querySelectorAll('[id]')].map(element => element.id);
  assert.equal(new Set(ids).size, ids.length, page + ' IDs are unique');
  for (const element of document.querySelectorAll('a[href], link[href], script[src]')) {
    const target = new URL(element.getAttribute('href') ?? element.getAttribute('src'), origin + page);
    if (target.origin !== new URL(origin).origin) continue;
    const relative = decodeURIComponent(target.pathname).slice(1);
    const local = new URL(relative, root);
    assert.ok(existsSync(fileURLToPath(local)), `${page} links to missing ${relative}`);
    if (target.pathname.endsWith('.html')) {
      linkedArticles.add(relative);
      if (target.hash) assert.ok(documentFor(target.pathname).getElementById(decodeURIComponent(target.hash.slice(1))), `${page} links to missing fragment ${relative}${target.hash}`);
    }
  }
}
for (const page of pages) assert.ok(linkedArticles.has(page), page + ' is reachable from the article collection');
console.log('PASS documentation: six complete article pages, local links/assets and HTML fragments resolve, unique IDs, all articles linked');
