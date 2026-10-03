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

## OAuth 应用配置（一次）

应用维护者先在飞书 / Google / Microsoft 注册 Lumi 的 OAuth 应用，设置服务端应用凭据；使用者随后只需点击“连接”，在官方页面登录并同意授权。仓库未内置已注册的 OAuth 应用。独立自托管实例可在设置 → 应用连接 → 高级设置中配置自己的应用，或使用下面的环境变量；环境配置优先，页面中的凭据输入会锁定。直接运行 Node 时需由启动器或系统服务注入环境变量；Compose 会读取 `.env`。

飞书：在 [开发者后台](https://open.feishu.cn/app) 创建 Lumi 应用，设置 `LUMEN_LARK_APP_ID` / `LUMEN_LARK_APP_SECRET`；或在高级设置填写，模式用 `oauth`。将设置页的完整回调 URI 加入「安全设置 → 重定向 URL」，默认 `http://localhost:8787/connectors/lark/callback`，端口使用实际服务端口。开通**用户身份**权限 `offline_access`、`im:message`、`im:message.send_as_user`、`docx:document`、`calendar:calendar`、`calendar:calendar:read`，启用刷新 `user_access_token`，发布并配置应用可用范围。`LUMEN_LARK_SCOPES` 可覆盖业务 scopes，`offline_access` 总会加入；使用减少后的范围时，未授权的业务操作将由飞书拒绝。授权使用随机 state、PKCE S256 和最新 OAuth v3 token 接口；消息、文档与日历以授权用户身份调用，日程明确写入可写的账户主日历，续期保存一次性的新版 refresh token，并发续期合并一次请求。断开连接也会阻止正在换令牌或续期的请求恢复旧账户。[授权码说明](https://open.feishu.cn/document/authentication-management/access-token/obtain-oauth-code.md)、[OAuth v3 令牌说明](https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/authentication-management/access-token/get-user-access-token-v3.md)、[主日历说明](https://open.feishu.cn/document/server-docs/calendar-v4/calendar/primary.md)

飞书公开接入有应用分发限制：**企业自建应用仅供同一企业使用**；供其他企业安装需商店应用资质和发布。开放平台注册的应用均为 Confidential Client，需要 App Secret；Public Client 未开放注册。因此可以由维护者的受控后端配置一次后供该实例使用者授权，不能把 Secret 打包到公开桌面客户端或 GitHub。面向任意企业的完整服务还需商店应用及多用户后端，当前个人服务没有这些基础设施。[飞书平台说明](https://open.feishu.cn/llms.txt)

账户授权目前支持飞书国内版。国际 Lark 继续支持原有 `app` 应用机器人与 `webhook` 群机器人模式；应用模式以机器人身份操作，Webhook 仅发群消息。这些配置保留在高级设置，与用户账户授权分开显示。

Google：创建 **Web application**，设置 `LUMEN_GOOGLE_CLIENT_ID` 和 `LUMEN_GOOGLE_CLIENT_SECRET`，启用 Gmail、Google Calendar API，完成品牌、受众与测试用户配置。登记设置页显示的完整回调 URI，默认 `http://localhost:8787/connectors/google/callback`，端口使用实际服务端口。公开提供给其他用户时需满足 Google 对相关 scopes 的发布和验证要求。[Google OAuth 文档](https://developers.google.com/identity/protocols/oauth2/web-server)

Microsoft：当前支持个人 Microsoft 账户。注册支持该受众的应用，并设置 `LUMEN_MICROSOFT_CLIENT_ID`。本机使用 **Mobile and desktop applications** 平台，登记完整 `http://localhost:8787/connectors/microsoft/callback`（按实际端口），Secret 留空；流程使用授权码 + PKCE。云端使用 **Web** 平台、HTTPS 回调，并设置 `LUMEN_MICROSOFT_CLIENT_SECRET` 为创建密钥时的 **Value**。设备码备用流程还需启用 Allow public client flows；它无需回调 URI。[Microsoft 授权码文档](https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-auth-code-flow)

云端连接需设置 `LUMEN_PUBLIC_URL=https://你的域名`，回调位于 `/connectors/lark/callback`、`/connectors/google/callback` 与 `/connectors/microsoft/callback`。默认本机回调为 localhost。授权 state 随机、10 分钟有效、绑定提供商与应用、只能消费一次；PKCE 的 verifier 仅存服务端。有效回调不依赖跨站 Cookie。成功后 Lumi 自动更新账户，取消或失败会显示结果。重新连接失败不会移除已有有效账户，断开连接会使待完成授权失效。

应用 Secret 与账户令牌不由状态 API 回传，也不进入模型上下文。环境变量中的应用 Secret 不复制到数据文件；账户令牌仍保存在私有数据目录的 0600 连接器文件中。更换应用 ID 后旧账户授权失效，需重新连接；这些能力仍按个人实例设计，未提供多用户账户隔离。

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
| `LUMEN_PUBLIC_URL` | 飞书 / Google / Microsoft OAuth 回调所用的公开 HTTPS 源 |
| `LUMEN_LARK_APP_ID` / `LUMEN_LARK_APP_SECRET` | 飞书应用凭据，Secret 仅放在受控服务端 |
| `LUMEN_LARK_REGION` / `LUMEN_LARK_SCOPES` | 默认 feishu；可选用户授权范围，始终包含 offline_access |
| `LUMEN_GOOGLE_CLIENT_ID` / `LUMEN_GOOGLE_CLIENT_SECRET` | 维护者注册的 Google Web 应用凭据 |
| `LUMEN_MICROSOFT_CLIENT_ID` / `LUMEN_MICROSOFT_CLIENT_SECRET` | Microsoft 应用 ID；Web 应用需 Secret，本机公共客户端留空 |
| `LUMEN_VM_SHELL=0` | 禁用旧宿主软沙箱终端 |

访问口令不等于多租户隔离，文件 0600 不等于静态加密，动作审批不等于全网络出口过滤。更多能力边界见 [核查报告](parity-audit-2026-10-02.md)。
