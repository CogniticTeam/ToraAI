# Grok 4.7 官方模型

通过枢流云 `https://shuliuyun.com/v1/responses` 接入 `grok-4.7`。密钥只放在 Worker Secret `SHULIUYUN_GROK_API_KEY` 中。桌面 ToChat、ToCode 及官网 ToChat 共用此路由，普通聊天不消耗 Agent 额度，工作与 ToCode 使用现有订阅池。

模型最大上下文设为 500,000 tokens，支持文字、图片和函数调用。思考档位为 `low`、`medium`、`high`、`xhigh`，默认 `high`。这些能力依据 [xAI 模型说明](https://docs.x.ai/developers/grok-4-7)；枢流云流式接口已单独验证。

Responses 适配器不请求思考摘要。加密思考记录以 `xai` 标记，与 GPT 的 `openai` 及豆包的 `ark` 隔离。服务端生成固定、不可由客户端覆盖的缓存亲和键；缓存是否命中取决于供应商。

## Credits

沿用现有服务费率：供应商人民币成本 × 400 Credits，并向上取整到每百万 tokens 的整数费率。截图提供的基础价格如下。

| 类型 | 截图价格 / 1M tokens | Credits / 1M tokens |
| --- | ---: | ---: |
| 输入 | ¥0.414 | 166 |
| 缓存输入 | ¥0.1035 | 42 |
| 输出（含思考） | ¥1.242 | 497 |

截图未展示长上下文费率。[xAI 官方价格页](https://docs.x.ai/developers/pricing)规定达到 200,000 输入 tokens 后，输入、缓存、输出均使用 2 倍单价。本实现先按此做保守预算：输入 332、缓存 83、输出 994 Credits / 1M tokens。它是 Tora 的预算策略，不表示已验证枢流云长上下文实际结算。取得供应商明确费率后，可通过 `AGENT_CREDIT_RATES` 覆盖配置调整。

每次按真实 `input_tokens`、`input_tokens_details.cached_tokens`、`output_tokens` 结算，思考 tokens 已包含在输出中，不重复扣费。

图标来自 [Lobe Icons](https://github.com/lobehub/lobe-icons)，MIT 许可，与现有 Gemini 图标来源一致。
