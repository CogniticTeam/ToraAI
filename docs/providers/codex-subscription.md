# 使用 Codex 订阅

## 接入步骤

1. 重启 Tora（此功能包含本地后端变更，仅刷新页面不够）。
2. 打开 **设置 → 模型 → 添加模型 → 使用你订阅的Codex套餐**。
3. 点击 **使用 ChatGPT 登录**，复制验证码，再点击 **打开授权页面**。
4. 在 OpenAI 官方页面完成登录并输入验证码。回到 Tora，选择账号返回的可用模型并保存。
5. 在对话模型选择器的 **Codex** 分组中选择模型。

不需要 API Key，也不需要安装 cc-switch 或 Codex CLI。设备码授权可能需要先在 ChatGPT 的安全设置中启用；组织工作区也可能需要管理员允许。验证码只应输入到 `https://auth.openai.com/codex/device`。

## 数据与额度

- 通过 ChatGPT 的 Codex 后端使用账号已有权限，与官方 Codex 共用订阅额度；不保证任何特定订阅都包含同一模型。
- 请求直接发往 OpenAI，不经过 Tora 云端模型网关。
- 桌面版通过 Electron `safeStorage` 加密保存到 Tora 数据目录的 `codex-auth.json`，文件以原子替换方式写入并限制访问权限。
- 没有可靠系统加密能力（包括 Linux `basic_text` 后端）时，只保存在进程内存中。界面会提示重启后需重新登录，不会静默写入明文。
- access token、refresh token、设备授权内部参数不会通过本地管理接口返回给页面，也不会进入 localStorage、云端模型列表或会话配置。
- 不读取、覆盖或修改 `~/.codex` / `~/.cc-switch` 中的登录数据。
- 模型选择为本机设置，现有云端模型同步不会覆盖它。退出 Tora 账号、清空数据或主动断开 Codex 时会清理此连接。
- “移除模型”只移除本机选择；“断开 Codex 连接”删除本机授权和已添加的 Codex 模型，不取消 ChatGPT 订阅。

## 路由与协议

独立凭证 `tora-codex`、类型 `codex_subscription` 与普通 API Key 模型分开解析，避免同名 GPT 模型串用接口或凭据。

- 模型列表：`https://chatgpt.com/backend-api/codex/models`，携带客户端版本查询参数。
- 生成：`https://chatgpt.com/backend-api/codex/responses`，使用 OAuth Bearer 与账号 workspace header。
- `codex-protocol.js` 集中维护客户端身份版本，模型发现与生成使用同一版本。
- 请求固定 `stream:true`、`store:false`，转换文本、图片、工具调用与工具结果，保留同一账号/模型下的加密推理上下文。
- 不发送此后端不支持的 Chat Completions 参数，不启用 priority / FAST 计费。
- token 提前刷新；并发刷新合并，单个请求取消不会中止其他请求共享的刷新。
- 401 在开始流式输出前最多刷新重试一次；网络错误、429、截断流不自动重放生成请求。响应未完整结束时不执行工具。

这不是面向其他应用的通用 HTTP 代理，也不包含多账号池、自动轮换或额度图表。

## 常见问题

- **无法取得验证码 / 403**：检查 ChatGPT 安全设置中的设备码授权、工作区管理策略及账号权限。
- **验证码过期**：重新开始登录。关闭或返回页面会取消当前轮询，迟到的授权结果不会重新连接账号。
- **已连接，但目录读取失败**：检查网络/系统代理，点击重试；不会用臆造模型代替真实目录。
- **授权失效**：重新登录，不要把 access token 当成 API Key 粘贴到普通服务商表单。
- **429**：额度与官方 Codex 共享，稍后再试；Tora 不会为此自动重复生成请求。
- **仅保存到内存的提示**：系统安全存储不可用；此进程仍可使用，重启后重新登录。

## 开发验证

单元测试使用临时 `TORA_HOME`、模拟 OAuth/Responses 和进程内 ASAPI 请求，不访问真实账号：

```bash
npm run test:codex
```

前端构建：

```bash
npm run build --prefix packages/desktop/frontend
```

真实前端 + 隔离 ASAPI 的浏览器回归（上游仍全部模拟，要求环境允许本地端口监听及启动 Chrome）：

```bash
npm run test:codex:ui
```

浏览器脚本覆盖取消授权、目录失败后重试、添加/启停/移除/断开、同名模型及云同步隔离；截图保存到 `output/codex-qa/`。没有 Chrome 时可设置 `TORA_CHROME_PATH`。

真实订阅验证需要用户自行在浏览器授权，再验证一次短回复和一次工具调用。模拟测试、构建成功不代表已经验证了真实账号、订阅权益或当前上游服务可用性。

## 参考与决策

按接口协议独立实现，不依赖 cc-switch 进程，不共享其他客户端的 refresh token，避免令牌轮换冲突。参考版本为 cc-switch `b184a88c99428571d718d10d1a1403e9502cd28b`：

- [订阅路由说明](https://github.com/farion1231/cc-switch/blob/b184a88c99428571d718d10d1a1403e9502cd28b/docs/guides/claude-codex-routing-guide-zh.md)
- [设备码与令牌刷新](https://github.com/farion1231/cc-switch/blob/b184a88c99428571d718d10d1a1403e9502cd28b/src-tauri/src/proxy/providers/codex_oauth_auth.rs)
- [模型发现](https://github.com/farion1231/cc-switch/blob/b184a88c99428571d718d10d1a1403e9502cd28b/src-tauri/src/services/codex_oauth_models.rs)
- [Responses 协议约束](https://github.com/farion1231/cc-switch/blob/b184a88c99428571d718d10d1a1403e9502cd28b/src-tauri/src/proxy/providers/transform_responses.rs)
- [OpenAI 登录说明](https://learn.chatgpt.com/docs/auth)
