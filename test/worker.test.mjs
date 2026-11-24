import test from 'node:test';
import assert from 'node:assert/strict';

import worker, {
  ensureProtocol,
  filterHeaders,
  shouldDropHeader,
  handleRedirect,
  replaceRelativePaths,
  setCorsHeaders,
  setNoCacheHeaders,
} from '../worker.js';

test('ensureProtocol 补全缺失的协议', () => {
  assert.equal(ensureProtocol('example.com', 'https:'), 'https://example.com');
  assert.equal(ensureProtocol('http://a.com', 'https:'), 'http://a.com');
  assert.equal(ensureProtocol('https://a.com', 'http:'), 'https://a.com');
});

test('replaceRelativePaths 把根相对路径改写成经代理的绝对路径', () => {
  const html = '<a href="/a">a</a><img src="/b.png"><form action="/c">';
  const out = replaceRelativePaths(html, 'https:', 'proxy.example.com', 'https://target.example.com');
  assert.ok(out.includes('href="https://proxy.example.com/https://target.example.com/a"'));
  assert.ok(out.includes('src="https://proxy.example.com/https://target.example.com/b.png"'));
  // 已经是绝对路径（// 开头）的不动
  const proto = replaceRelativePaths('<a href="//cdn.example.com/x">', 'https:', 'p.com', 'https://t.com');
  assert.ok(proto.includes('href="//cdn.example.com/x"'));
});

test('handleRedirect 相对 Location 也能改写，且保留原响应头', () => {
  const origin = new Response(null, {
    status: 302,
    headers: { location: '/login?next=/a', 'x-from-origin': 'yes', 'content-type': 'text/plain' },
  });
  const res = handleRedirect(origin, null, 'https://target.example.com/start');
  assert.equal(res.status, 302);
  assert.equal(res.headers.get('x-from-origin'), 'yes');
  assert.equal(
    res.headers.get('location'),
    '/' + encodeURIComponent('https://target.example.com/login?next=/a'),
  );
});

test('handleRedirect 不丢头、缺少 Location 时也安全', () => {
  const res = handleRedirect(new Response(null, { status: 301 }), null, 'https://t.com/');
  assert.equal(res.status, 301);
  assert.equal(res.headers.get('location'), null);
});

test('shouldDropHeader 丢掉 cf-/accept-encoding 等头', () => {
  assert.equal(shouldDropHeader('cf-connecting-ip'), true);
  assert.equal(shouldDropHeader('Accept-Encoding'), true);
  assert.equal(shouldDropHeader('host'), true);
  assert.equal(shouldDropHeader('user-agent'), false);

  const headers = new Headers({ 'cf-connecting-ip': '1.2.3.4', 'user-agent': 'ua/1', 'accept-encoding': 'gzip' });
  const filtered = filterHeaders(headers, (name) => !shouldDropHeader(name));
  assert.equal(filtered.get('cf-connecting-ip'), null);
  assert.equal(filtered.get('accept-encoding'), null);
  assert.equal(filtered.get('user-agent'), 'ua/1');
});

test('CORS / no-cache 头', () => {
  const h = new Headers();
  setCorsHeaders(h);
  setNoCacheHeaders(h);
  assert.equal(h.get('access-control-allow-origin'), '*');
  assert.equal(h.get('cache-control'), 'no-store');
});

test('根路径返回带表单的 HTML 页面', async () => {
  const res = await worker.fetch(new Request('https://p.com/'));
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/html/);
  const html = await res.text();
  assert.ok(html.includes('Proxy Everything'));
  assert.ok(html.includes('id="targetUrl"'));
});
