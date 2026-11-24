// Cloudflare Workers 现在只支持 ES Module 写法；旧的 addEventListener 格式无法用
// wrangler / 一键部署上线，这里改成 export default { fetch }。
export default {
  async fetch(request) {
    return handleRequest(request);
  },
};

async function handleRequest(request) {
  try {
      const url = new URL(request.url);

      // 如果访问根目录，返回HTML
      if (url.pathname === "/") {
          return new Response(getRootHtml(), {
              headers: {
                  'Content-Type': 'text/html; charset=utf-8'
              }
          });
      }

      // 从请求路径中提取目标 URL
      let actualUrlStr = decodeURIComponent(url.pathname.replace("/", ""));

      // 判断用户输入的 URL 是否带有协议（ws/wss 需要映射成 http/https 才能 fetch）
      actualUrlStr = ensureProtocol(actualUrlStr, url.protocol);

      // 保留查询参数
      actualUrlStr += url.search;

      // 创建新 Headers 对象：丢掉 cf- 前缀头，以及会导致 Workers 无法自动解压/改写的头
      const newHeaders = filterHeaders(request.headers, name => !shouldDropHeader(name));

      // WebSocket 升级请求走单独的通道，不能套用 HTTP 改写逻辑
      if (isWebSocketRequest(request)) {
          return handleWebSocket(newHeaders, actualUrlStr);
      }

      // 创建一个新的请求以访问目标 URL
      const modifiedRequest = new Request(actualUrlStr, {
          headers: newHeaders,
          method: request.method,
          body: request.body,
          redirect: 'manual'
      });

      // 发起对目标 URL 的请求
      const response = await fetch(modifiedRequest);
      let body = response.body;

      // 处理重定向
      if ([301, 302, 303, 307, 308].includes(response.status)) {
          return handleRedirect(response, response.body, actualUrlStr);
      } else if (response.headers.get("Content-Type")?.includes("text/html")) {
          body = await handleHtmlContent(response, url.protocol, url.host, actualUrlStr);
      }

      // 创建修改后的响应对象
      const modifiedResponse = new Response(body, {
          status: response.status,
          statusText: response.statusText,
          headers: response.headers
      });

      // 内容可能被改写（HTML 相对路径），长度和编码交给 Workers 重新计算
      modifiedResponse.headers.delete('content-length');
      modifiedResponse.headers.delete('content-encoding');

      // 添加禁用缓存的头部
      setNoCacheHeaders(modifiedResponse.headers);

      // 添加 CORS 头部，允许跨域访问
      setCorsHeaders(modifiedResponse.headers);

      return modifiedResponse;
  } catch (error) {
      // 如果请求目标地址时出现错误，返回带有错误消息的响应和状态码 500（服务器错误）
      return jsonResponse({
          error: error.message
      }, 500);
  }
}

// 确保 URL 带有协议；接受 http/https/ws/wss 四种
const HAS_PROTOCOL = /^(https?|wss?):\/\//i;

function ensureProtocol(url, defaultProtocol) {
  return HAS_PROTOCOL.test(url) ? url : defaultProtocol + "//" + url;
}

// ws:// → http://，wss:// → https://（Workers 的 fetch 只能发 HTTP(S) 请求）
function toUpstreamUrl(urlStr) {
  if (/^ws:\/\//i.test(urlStr)) return "http://" + urlStr.slice(5);
  if (/^wss:\/\//i.test(urlStr)) return "https://" + urlStr.slice(6);
  return urlStr;
}

function isWebSocketRequest(request) {
  return (request.headers.get("upgrade") || "").toLowerCase() === "websocket";
}

// WebSocket 代理：把连接透传到目标站，握手成功后交给 Workers 双向转发
async function handleWebSocket(headers, targetUrl) {
  const wsHeaders = new Headers(headers);
  wsHeaders.set("upgrade", "websocket");

  let response;
  try {
    response = await fetch(toUpstreamUrl(targetUrl), {
      headers: wsHeaders,
      method: "GET",
      redirect: "manual",
    });
  } catch (error) {
    return jsonResponse({ error: error.message }, 502);
  }

  if (response.status !== 101 || !response.webSocket) {
    return jsonResponse(
      { error: "websocket handshake failed", upstreamStatus: response.status },
      502
    );
  }

  return new Response(null, { status: 101, webSocket: response.webSocket });
}

// 处理重定向：把目标站的 Location 改写成「代理前缀 + 原始地址」的形式
function handleRedirect(response, body, actualUrlStr) {
  const rawLocation = response.headers.get('location');
  const headers = new Headers(response.headers);
  if (rawLocation) {
    let absolute;
    try {
      absolute = new URL(rawLocation, actualUrlStr).toString();
    } catch {
      absolute = rawLocation;
    }
    headers.set('Location', `/${encodeURIComponent(absolute)}`);
  }
  return new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers
  });
}

// 处理 HTML 内容中的相对路径
async function handleHtmlContent(response, protocol, host, actualUrlStr) {
  const originalText = await response.text();
  return replaceRelativePaths(originalText, protocol, host, new URL(actualUrlStr).origin);
}

// 替换 HTML 内容中的相对路径
function replaceRelativePaths(text, protocol, host, origin) {
  const regex = new RegExp('((href|src|action)=["\'])/(?!/)', 'g');
  return text.replace(regex, `$1${protocol}//${host}/${origin}/`);
}

// 返回 JSON 格式的响应
function jsonResponse(data, status) {
  return new Response(JSON.stringify(data), {
      status: status,
      headers: {
          'Content-Type': 'application/json; charset=utf-8'
      }
  });
}

// 过滤请求头
function filterHeaders(headers, filterFunc) {
  return new Headers([...headers].filter(([name]) => filterFunc(name)));
}

// 这些请求头不能转发给目标站：
// - cf-* : Cloudflare 内部头
// - accept-encoding : 转发后 Workers 不再自动解压，响应会变成无法处理的压缩流
// - host / content-length / connection 等 : 由 fetch 重新计算，转发会报错或错乱
const DROPPED_HEADERS = new Set([
  'accept-encoding',
  'host',
  'content-length',
  'connection',
  'keep-alive',
  'proxy-connection',
  'transfer-encoding',
  'upgrade',
  // Workers 自己完成 WebSocket 握手，转发这些头会握手失败
  'sec-websocket-key',
  'sec-websocket-version',
  'sec-websocket-extensions',
  'sec-websocket-accept',
]);

function shouldDropHeader(name) {
  const lower = name.toLowerCase();
  return lower.startsWith('cf-') || DROPPED_HEADERS.has(lower);
}

// 设置禁用缓存的头部
function setNoCacheHeaders(headers) {
  headers.set('Cache-Control', 'no-store');
}

// 设置 CORS 头部
function setCorsHeaders(headers) {
  headers.set('Access-Control-Allow-Origin', '*');
  headers.set('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE');
  headers.set('Access-Control-Allow-Headers', '*');
}

// 返回根目录的 HTML
function getRootHtml() {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <link href="https://s4.zstatic.net/ajax/libs/materialize/1.0.0/css/materialize.min.css" rel="stylesheet">
  <title>Proxy Everything</title>
  <link rel="icon" type="image/png" href="https://s2.hdslb.com/bfs/openplatform/1682b11880f5c53171217a03c8adc9f2e2a27fcf.png@100w.webp">
  <meta name="Description" content="Proxy Everything with CF Workers.">
  <meta property="og:description" content="Proxy Everything with CF Workers.">
  <meta property="og:image" content="https://s2.hdslb.com/bfs/openplatform/1682b11880f5c53171217a03c8adc9f2e2a27fcf.png@100w.webp">
  <meta name="robots" content="index, follow">
  <meta http-equiv="Content-Language" content="zh-CN">
  <meta name="copyright" content="Copyright © ymyuuu">
  <meta name="author" content="ymyuuu">
  <link rel="apple-touch-icon-precomposed" sizes="120x120" href="https://s2.hdslb.com/bfs/openplatform/1682b11880f5c53171217a03c8adc9f2e2a27fcf.png@100w.webp">
  <meta name="apple-mobile-web-app-capable" content="yes">
  <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
  <meta name="viewport" content="width=device-width, user-scalable=no, initial-scale=1.0, maximum-scale=1.0, minimum-scale=1.0, user-scalable=no">
  <style>
      body, html {
          height: 100%;
          margin: 0;
      }
      .background {
          background-size: cover;
          background-position: center;
          height: 100%;
          display: flex;
          align-items: center;
          justify-content: center;
      }
      .card {
          background-color: rgba(255, 255, 255, 0.8);
          transition: background-color 0.3s ease, box-shadow 0.3s ease;
      }
      .card:hover {
          background-color: rgba(255, 255, 255, 1);
          box-shadow: 0px 8px 16px rgba(0, 0, 0, 0.3);
      }
      .input-field input[type=text] {
          color: #2c3e50;
      }
      .input-field input[type=text]:focus+label {
          color: #2c3e50 !important;
      }
      .input-field input[type=text]:focus {
          border-bottom: 1px solid #2c3e50 !important;
          box-shadow: 0 1px 0 0 #2c3e50 !important;
      }
      @media (prefers-color-scheme: dark) {
          body, html {
              background-color: #121212;
              color: #e0e0e0;
          }
          .card {
              background-color: rgba(33, 33, 33, 0.9);
              color: #ffffff;
          }
          .card:hover {
              background-color: rgba(50, 50, 50, 1);
              box-shadow: 0px 8px 16px rgba(0, 0, 0, 0.6);
          }
          .input-field input[type=text] {
              color: #ffffff;
          }
          .input-field input[type=text]:focus+label {
              color: #ffffff !important;
          }
          .input-field input[type=text]:focus {
              border-bottom: 1px solid #ffffff !important;
              box-shadow: 0 1px 0 0 #ffffff !important;
          }
          label {
              color: #cccccc;
          }
      }
  </style>
</head>
<body>
  <div class="background">
      <div class="container">
          <div class="row">
              <div class="col s12 m8 offset-m2 l6 offset-l3">
                  <div class="card">
                      <div class="card-content">
                          <span class="card-title center-align"><i class="material-icons left">link</i>Proxy Everything</span>
                          <form id="urlForm" onsubmit="redirectToProxy(event)">
                              <div class="input-field">
                                  <input type="text" id="targetUrl" placeholder="在此输入目标地址" required>
                                  <label for="targetUrl">目标地址</label>
                              </div>
                              <button type="submit" class="btn waves-effect waves-light teal darken-2 full-width">跳转</button>
                          </form>
                      </div>
                  </div>
              </div>
          </div>
      </div>
  </div>
  <script src="https://s4.zstatic.net/ajax/libs/materialize/1.0.0/js/materialize.min.js"></script>
  <script>
      function redirectToProxy(event) {
          event.preventDefault();
          const targetUrl = document.getElementById('targetUrl').value.trim();
          const currentOrigin = window.location.origin;
          window.open(currentOrigin + '/' + encodeURIComponent(targetUrl), '_blank');
      }
  </script>
</body>
</html>`;
}

// 导出纯函数，供 test/worker.test.mjs 单测
export {
  ensureProtocol,
  filterHeaders,
  handleWebSocket,
  isWebSocketRequest,
  toUpstreamUrl,
  handleRedirect,
  replaceRelativePaths,
  setCorsHeaders,
  setNoCacheHeaders,
  shouldDropHeader,
};
