# Claude 5.5 官方模型

官方目录提供 `claude-opus-5-5`、`claude-sonnet-5-5`、`claude-haiku-5-5`，覆盖桌面 ToChat、ToCode 和官网 ToChat。三者共用 Worker Secret `SHULIUYUN_CLAUDE_API_KEY`，通过枢流云 `https://shuliuyun.com/v1/chat/completions` 调用。客户端与源码不包含密钥。

`claude-opus-5` 不再出现在官方菜单，服务端在调用上游和预留额度前拒绝它。历史记录不删除，旧选择保留原名称并置为不可用，用户主动选择替代模型后才可继续，避免静默回退到 DeepSeek。旧费率仅保留供历史用量核对。

## 协议与能力

[Opus 5.5](https://platform.claude.com/docs/en/models/opus-5-5/overview)、[Sonnet 5.5](https://platform.claude.com/docs/en/models/sonnet-5-5/overview) 与 [Haiku 5.5](https://platform.claude.com/docs/en/models/haiku-5-5/overview) 官方文档声明 1M 上下文、文字与图片输入、五档思考强度 `low/medium/high/xhigh/max`。上下文配置为 1,000,000，扣除运行时预留空间，不提供上下文选择器；单次输出仍受现有服务 16,384 上限与可用额度限制。

枢流云新版 Claude 要求 `thinking.type=adaptive` 与 `output_config.effort`。旧兼容字段 `reasoning_effort` 会令 Opus/Sonnet 5.5 返回 HTTP 400，因此由 Worker 统一转换并覆盖客户端附加字段，不由客户端直接调用供应商。

工具使用 `tool_choice=auto`。[Opus 5.5 不支持强制工具选择](https://platform.claude.com/docs/en/models/opus-5-5/overview)，标题生成也不强制 `return_title`；优先使用已配置的轻量 Gemini，否则用原模型低档文本命名。正文与工具结果仍通过统一流式消息接口续接。

2026-10-10 枢流云实测：三个 ID 的流式请求、64×64 合成红色图片识别、函数调用与 `max` 档工具结果续接均返回 HTTP 200。上游实际返回模型名与所选 ID 一致。未发送百万 tokens 请求验证上下文上限。

供应商行为边界：Opus 5.5 的两次“仅按 system 指令返回指定字串”测试（Chat Completions 与原生 Messages）均返回通用问候，未满足测试指令；后续 user 指令与图片工具任务正常完成。Tora 按协议保留 system 消息，不将 HTTP 200 视为完整指令服从证明。验证记录中同时保留这些结果。

## Credits

沿用供应商截图成本 × 400 Credits/CNY，向上取整到每百万 tokens 整数费率。

| 模型 | 输入 / 缓存 / 输出人民币价格（每 1M） | 输入 / 缓存 / 输出 Credits（每 1M） |
| --- | --- | --- |
| Haiku 5.5 | ¥0.161 / ¥0.0161 / ¥0.805 | 65 / 7 / 322 |
| Sonnet 5.5 | ¥0.288 / ¥0.0288 / ¥1.44 | 116 / 12 / 576 |
| Opus 5.5 | ¥0.576 / ¥0.0288 / ¥2.88 | 231 / 12 / 1152 |

按实际 `prompt_tokens`、`prompt_tokens_details.cached_tokens`、`completion_tokens` 结算。枢流云响应同时包含原生别名和规范字段时，规范字段优先，不能使用为零的 `output_tokens` 漏算输出。缓存从总输入中扣除，思考已包含在输出里，不重复收费。

普通 ToChat 聊天不占用工作额度，工作模式与 ToCode 共用订阅池。截图未给出缓存写入或长上下文独立价格，本次按输入价覆盖缓存写入，未另加未确认的供应商分段价；可通过 `AGENT_CREDIT_RATES` 调整。
