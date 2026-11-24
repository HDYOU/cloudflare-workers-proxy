# Cloudflare Workers Proxy

这是一个基于 Cloudflare Workers 的简单反向代理脚本，用于将客户端的请求转发到目标地址，并将目标地址的响应返回给客户端。在使用本脚本之前，请务必详细阅读以下安全注意事项和免责声明，以确保使用脚本时的安全和法律合规性。

- 群聊: [HeroCore](https://t.me/HeroCore)
- 频道: [HeroMsg](https://t.me/HeroMsg)

## 简介

这个 Cloudflare Workers 脚本充当了一个反向代理，它的主要功能是接收客户端的请求，并将请求代理到目标地址，然后将目标地址的响应返回给客户端。具体功能包括：

- 代理客户端请求到目标地址。
- 修改响应中的相对路径为绝对路径，以确保资源的正确加载。
- 处理重定向并进行适当的修改，以保持资源路径的正确性。
- 添加 CORS 头部，以允许跨域访问。

## 如何部署

三种方式任选其一，仓库里已经带了 `wrangler.toml` 和 `package.json`，不用再手动粘贴代码。

### 方式一：一键部署（推荐）

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/HDYOU/cloudflare-workers-proxy)

点上面的按钮 → 授权 GitHub → Cloudflare 自动建仓库、装依赖、跑 `wrangler deploy`，一分钟拿到 `https://cloudflare-workers-proxy.<你的子域>.workers.dev`，之后每次 push 到 `main` 都会自动重新部署。

### 方式二：命令行 wrangler

```bash
git clone https://github.com/HDYOU/cloudflare-workers-proxy.git
cd cloudflare-workers-proxy
npm install
npx wrangler login        # 浏览器里点一下授权
npm run dev               # 本地 http://localhost:8787 调试
npm run deploy            # 发布到 Cloudflare
```

部署成功后域名形如 `https://cloudflare-workers-proxy.<你的子域>.workers.dev`。

### 方式三：控制台粘贴

登录 Cloudflare → Workers & Pages → Create → Worker，把 [worker.js](worker.js) 的内容整段粘进编辑器（**注意**：必须以 `export default` 的 ES Module 形式保存，旧的 `addEventListener` 写法已经不能新建 Worker 了），然后 Deploy。

### 自定义域名 / 路由

编辑 `wrangler.toml` 取消注释这一行，或在控制台 Workers → Settings → Domains & Routes 里绑定：

```toml
routes = [{ pattern = "proxy.example.com", custom_domain = true }]
```

### 本地测试与单测

```bash
npm run dev     # 本地起服务
npm test        # 7 项单测：URL 补协议、相对路径改写、重定向、头过滤、根页面
```

## 使用方法

要使用此反向代理访问其他网站，请按照以下步骤操作：

1. 发出请求：只需向您的 Cloudflare Workers URL 发出请求，将请求发送到目标网站。

   示例请求：`https://your-worker-url.com/https://example.com/`

   将 `your-worker-url.com` 替换为您的 Cloudflare Workers URL，`example.com` 替换为您要代理的目标网站的地址。

2. 处理重定向

   反向代理脚本能够处理重定向并适当修改资源路径，以确保正确性。

3. 允许跨域请求

   反向代理添加了 CORS（跨源资源共享）头部，以允许跨域请求。这意味着您可以在前端 JavaScript 代码中从不同域（不同域名）发起请求，而不会受到浏览器的跨域安全限制。

4. 用户友好界面

   如果您未提供目标网站的 URL，此反向代理还提供了一个用户友好的界面。用户可以在此界面中输入目标网站的 URL，然后点击 "进入代理" 按钮，以便快速代理访问目标网站。

## 相对原脚本的改动

为了能真正用 wrangler / 一键部署跑起来，本仓库对 `worker.js` 做了几处必要修正：

- 入口从 `addEventListener('fetch')` 改为 `export default { fetch }`（Cloudflare 已不再支持新建 Service Worker 语法的 Worker）。
- 转发请求时剔除 `accept-encoding`、`host`、`content-length`、`connection` 等头。原脚本会把 `accept-encoding` 原样转发，导致 Workers 不再自动解压，返回的 HTML 变成乱码压缩流，相对路径改写也就失效了。
- 重定向处理：原来的 `new URL(location)` 遇到相对 Location 会抛错，且 `{ ...response.headers }` 展开 `Headers` 对象其实是空对象（响应头全丢）。现在改为基于实际请求 URL 解析相对地址，并用 `new Headers()` 复制原响应头。
- 新增 `wrangler.toml`、`package.json`（`dev` / `deploy` 脚本）、`.gitignore` 和 `test/worker.test.mjs`。

## 注意事项

- 请确保部署的 Workers 脚本在部署时是有效的，并且有足够的资源来处理请求。

- 请注意不要滥用该服务，确保只将它用于合法和合适的用途。

## 免责声明

- **责任限制**：作者不对脚本可能导致的任何安全问题、数据损失、服务中断、法律纠纷或其他损害负责。使用此脚本需自行承担风险。

- **不当使用**：使用者需了解，本脚本可能被用于非法活动或未经授权的访问。作者强烈反对和谴责任何不当使用脚本的行为，并鼓励合法合规的使用。

- **合法性**：请确保遵守所有适用的法律、法规和政策，包括但不限于互联网使用政策、隐私法规和知识产权法。确保您拥有对目标地址的合法权限。

- **自担风险**：使用此脚本需自行承担风险。作者和 Cloudflare 不对脚本的滥用、不当使用或导致的任何损害承担责任。

**此免责声明针对非中国大陆地区用户，如在中国大陆地区使用，需遵守相关地区法律法规，且由使用者自行承担相应风险与责任。**


## 资源

- [Cloudflare Workers 文档](https://developers.cloudflare.com/workers)
- [Cloudflare Workers 设置](https://developers.cloudflare.com/workers/platform/settings)

[![Powered by DartNode](https://dartnode.com/branding/DN-Open-Source-sm.png)](https://dartnode.com "Powered by DartNode - Free VPS for Open Source")

## 许可证

本项目采用 MIT 许可证。详细信息请参阅 [LICENSE](LICENSE) 文件。

感谢您的使用！如果您对这个项目有任何改进或建议，也欢迎贡献代码或提出问题。
