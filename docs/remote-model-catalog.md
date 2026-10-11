# 远程模型管理

管理端「模型与渠道」管理官方模型，个人自定义模型继续走原有账户模型接口。

## 生效规则

- 模型名称、上游模型 ID、渠道、提供商、上下文/输出上限、输入能力、思考参数、开放模式、最低订阅及 Credits 单价统一存储在 D1。
- 服务端每次请求读取最新配置；新版桌面及官网 ToChat 每约 30 秒刷新目录。关闭、删除或提高权限会拦截新请求，保存的对话不会自动换模型。网络失败时保留已知目录并暂停官方模型选择。
- 工作模式与 ToCode 按每百万 Tokens 的内部 Credits 单价扣费。聊天模式沿用不扣工作额度的规则。DeepSeek 体验次数、豆包每日免费工作机会不随目录更新重置。
- 每个请求固定开始时的目录版本和价格，在 `official_request_prices` 保存价格快照；生成中修改价格不会追溯影响该请求。配置修改写入 `official_catalog_audit`。
- 删除采用软删除；管理端勾选「显示已删除模型」可以恢复。模型 ID 不改名，显示名和上游 ID 可以修改。使用中的渠道先解绑才能删除。
- 各次保存携带目录 revision；并发编辑返回 409，刷新后重新编辑。

## API（管理密钥认证）

| 接口 | 功能 |
|---|---|
| `GET /admin/official-models` | 返回模型、渠道、版本及密钥是否已配置，绝不返回 API Key 或密文 |
| `POST /admin/official-models` | 新增模型，含 `revision` |
| `PATCH /admin/official-models/:id` | 修改字段或恢复模型，含 `revision` |
| `DELETE /admin/official-models/:id` | 软删除，JSON 中含 `revision` |
| `POST /admin/model-channels` | 新增渠道并加密 API Key |
| `PATCH /admin/model-channels/:id` | 修改渠道；API Key 留空保留现有密钥 |
| `DELETE /admin/model-channels/:id` | 删除没有在用模型的渠道 |

每个模型配置 `rates.input/cached/output`（整数 Credits / 1M Tokens）。可选 `threshold/longInput/longCached/longOutput` 表示超过阈值后的价格，可选 `audioInput/audioCached` 表示音频输入价。

## 密钥与部署

新渠道支持 HTTPS 公网接口，使用 Bearer 认证。协议为 Chat Completions 或 Responses；Responses 可选择 OpenAI、方舟、xAI 适配器。音视频上传只支持方舟 Responses。这里不支持 Anthropic 原生 Messages 或任意自定义脚本协议。

API Key 使用 AES-256-GCM，加密时绑定渠道 ID；数据库、审计和客户端响应没有明文 Key。加密主密钥放在 Worker Secret `MODEL_CATALOG_ENCRYPTION_KEY`，是 32 字节随机值的 Base64。首次配置即可，不能在以后发布时重新生成覆盖，否则旧渠道无法解密。预置渠道继续引用已有 Worker Secrets，更换它们的 API 地址必须同时提供新 Key。

`0011_official_model_catalog.sql` 只新增目录、审计和价格快照表。首次服务读取会安全地建表并从现有静态模型及环境价格配置初始化一次；此后远程目录具有权威性。回滚应用不会删除此目录或历史计费记录。

桌面端需要一次含动态运行时目录的新安装包。新增模型之后不再需要修改静态白名单或发安装包；仅修改权限和价格时服务端即时生效。热更新包若依赖这次新增的 core 能力，最低壳版本必须设置为包含该能力的版本（下一次安装包至少 1.1.1），不能下发给旧 1.1.0。
