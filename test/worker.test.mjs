import test from 'node:test';
import assert from 'node:assert/strict';

import worker, {
  ensureProtocol,
  filterHeaders,
  handleWebSocket,
  isWebSocketRequest,
  toUpstreamUrl,
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

test('ensureProtocol 支持 ws / wss', () => {
  assert.equal(ensureProtocol('wss://echo.example.com/ws', 'https:'), 'wss://echo.example.com/ws');
  assert.equal(ensureProtocol('ws://echo.example.com/ws', 'https:'), 'ws://echo.example.com/ws');
});

test('toUpstreamUrl 把 ws/wss 映射成 http/https', () => {
  assert.equal(toUpstreamUrl('ws://a.com/s'), 'http://a.com/s');
  assert.equal(toUpstreamUrl('wss://a.com/s?x=1'), 'https://a.com/s?x=1');
  assert.equal(toUpstreamUrl('https://a.com/s'), 'https://a.com/s');
});

test('isWebSocketRequest 识别 Upgrade: websocket', () => {
  const ws = new Request('https://p.com/wss%3A%2F%2Fa.com%2Fs', { headers: { upgrade: 'websocket' } });
  const http = new Request('https://p.com/https%3A%2F%2Fa.com%2F');
  assert.equal(isWebSocketRequest(ws), true);
  assert.equal(isWebSocketRequest(http), false);
});

test('handleWebSocket 握手成功返回 101 + socket', async () => {
  // Node 的 Response 不允许 status 101，这里用假 Response 记录构造参数
  const OriginalResponse = globalThis.Response;
  const OriginalFetch = globalThis.fetch;
  const calls = [];
  let builtInit = null;

  globalThis.fetch = async (url, init) => {
    calls.push({ url, headers: init.headers });
    return { status: 101, webSocket: { fake: true } };
  };
  globalThis.Response = class {
    constructor(body, init) {
      builtInit = init;
      this.status = init.status;
      this.webSocket = init.webSocket;
    }
  };

  try {
    const res = await handleWebSocket(new Headers({ 'user-agent': 'ua/1' }), 'wss://echo.example.com/ws');
    assert.equal(res.status, 101);
    assert.deepEqual(res.webSocket, { fake: true });
    assert.equal(builtInit.status, 101);
    assert.equal(calls[0].url, 'https://echo.example.com/ws');
    assert.equal(calls[0].headers.get('upgrade'), 'websocket');
    assert.equal(calls[0].headers.get('user-agent'), 'ua/1');
  } finally {
    globalThis.fetch = OriginalFetch;
    globalThis.Response = OriginalResponse;
  }
});

test('handleWebSocket 握手失败返回 502', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => ({ status: 200, webSocket: null });
  try {
    const res = await handleWebSocket(new Headers(), 'wss://echo.example.com/ws');
    assert.equal(res.status, 502);
    const body = await res.json();
    assert.equal(body.error, 'websocket handshake failed');
  } finally {
    globalThis.fetch = original;
  }
});
