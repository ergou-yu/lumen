# Lumi 常在线部署

关掉网页后，后台任务仍由 Node 服务桥执行。让本人电脑关机后也能工作，需要将服务部署到另外一台常在线主机。这里提供部署配置，未在本次任务中实际开通云主机。

## 本机或独立主机直接运行

需要 Node ≥18。不要把浏览器里的 Key 当作已配置后台：通过活动页明确启用，或设置 `LUMEN_MODEL_TYPE / BASE / NAME / API_KEY`。推荐用系统服务管理器维持 `node server.js` 运行，工作目录指向仓库，设置 `LUMEN_DATA_DIR` 到私有、可备份的目录。

```bash
LUMEN_NO_OPEN=1 \
LUMEN_DATA_DIR=/你的私有数据目录 \
LUMEN_ACCESS_TOKEN=你的高强度口令 \
LUMEN_HOST=127.0.0.1 \
node server.js
```

仅从同机访问时使用回环地址。跨设备访问用 HTTPS 反向代理到回环端口；公网应阻止绕过代理直接访问 Node 端口。代理保留 Host，并设置 `X-Forwarded-Proto: https`。登录会话使用 Secure Cookie。平台回调位于 `/channels/<平台>/events`，平台签名校验独立于访问口令，代理必须原样转发请求字节与签名头。

这仍是个人服务，一份数据目录绑定一个个人身份，不要把一份口令发给多个人当作多用户系统。

Google OAuth 在云端需设置 `LUMEN_PUBLIC_URL=https://你的域名`，并在自己的 Google Web 应用中登记完全一致的 `/connectors/google/callback` redirect URI。默认本机回调为 localhost。授权 state 随机、10 分钟有效、只能消费一次，因此回调不依赖 127.0.0.1 与 localhost 之间无法共享的登录 Cookie。[Google OAuth 文档](https://developers.google.com/identity/protocols/oauth2/web-server)

## Docker Compose

复制 `.env.example` 到 `.env`，填写访问口令、自己的模型端点及模型 Key。`.env` 已忽略，不要提交。执行：

```bash
docker compose up -d --build
```

默认只将端口绑定到宿主 `127.0.0.1:8787`，通过 HTTPS 反向代理对外提供页面。配置使用非 root 用户、只读应用文件、持久 `lumi-data` 卷及重启策略。

该应用容器可运行通用任务、搜索、文件产物、计划、记忆和渠道入口。**默认没有 Docker socket、QCU 或桌面环境**，因此不能在容器内启动 LumenBox Desktop、隔离代码工具或托管 Hindsight。需要这些能力时，在具有 Docker daemon 的独立主机直接运行 Node 服务桥并配置对应环境；不要把 Docker socket 随意挂进公开服务容器。

## 数据和生命周期

备份私有数据目录或 `lumi-data` 卷，包括后台状态、模型配置、连接器、渠道配置及 `vm-home`。这些文件可能含个人内容和凭证；不要放入 GitHub。

普通运行任务在重启后按检查点继续。执行外部写入时服务中断，状态会变成“需要核实外部结果”，不会自动重发。桌面任务重启后停止，需检查页面再委托。恢复计划时错过多次运行会合并一项；截止时间和同计划在途任务约束仍生效。

计划只读模式允许研究、保存建议与研究笔记，不发消息、不写产物、不控制电脑。完成通知可使用已有 Webhook 或绑定本人的平台私聊。平台真实凭证/OAuth 与公网回调连通性需自行实际接入验收。

## 环境变量

| 变量 | 用途 |
|---|---|
| `LUMEN_DATA_DIR` | 私有状态与工作区根目录 |
| `LUMEN_ACCESS_TOKEN` | 访问口令；Compose 要求配置 |
| `LUMEN_HOST` / `PORT` | 监听地址和端口 |
| `LUMEN_NO_OPEN=1` | 服务启动不打开浏览器 |
| `LUMEN_MODEL_TYPE` | openai / anthropic / gemini |
| `LUMEN_MODEL_BASE` | 所选协议的 base URL |
| `LUMEN_MODEL_NAME` | 文本/视觉模型名称 |
| `LUMEN_MODEL_API_KEY` | 自己的模型 Key |
| `LUMEN_IMAGE_MODEL` | Images API 的图像模型名称 |
| `LUMEN_PUBLIC_URL` | 云端Google OAuth回调所用的公开HTTPS源 |
| `LUMEN_VM_SHELL=0` | 禁用旧宿主软沙箱终端 |

访问口令不等于多租户隔离，文件 0600 不等于静态加密，动作审批不等于全网络出口过滤。更多能力边界见 [核查报告](parity-audit-2026-10-02.md)。
