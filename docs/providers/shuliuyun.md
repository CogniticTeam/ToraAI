# 枢流云

官网：https://shuliuyun.com/

## 在桌面版配置

1. 打开“设置 → 模型 → 添加模型”，选择“枢流云”。
2. 点击“获取 API 密钥”进入枢流云控制台，填写自己的 API Key。
3. 拉取令牌可访问的模型列表并选择模型，或手动填写模型 ID。
4. 保存后，在对话输入框的模型选择器中选择刚添加的模型。

模型配置及 API 密钥会同步至当前 Tora 账户，并在本机保留运行所需的模型配置。

预设基础地址为 `https://shuliuyun.com/v1`。模型发现使用 `GET /v1/models`，对话使用 OpenAI 兼容的 `POST /v1/chat/completions`，鉴权为 `Authorization: Bearer <API Key>`。

CLI 可通过 `tora config` 填写相同基础地址、自己的 API Key 和模型 ID。

枢流云官网链接到的 [New API 文档](https://docs.newapi.pro/en/docs/guide/feature-guide/user/api)说明了该接口与鉴权方式。此预设使用 Chat Completions 通道；实际可用模型和能力由枢流云账户及通道决定。

模型列表默认筛选聊天候选项。需要其他模型时可手动输入，实际请求错误会保留显示。

## ToChat 内置 Gemini

ToChat 的模型菜单提供 `Gemini 3.8 Flash`（模型 ID：`gemini-3.8-flash`），由枢流云的 OpenAI 兼容接口提供流式回复及工具调用。保留原有 DeepSeek Flash，可在任务空闲时切换模型，所选模型记录在该对话中。旧对话仍使用 DeepSeek；普通聊天不扣工作额度；工作模式与 ToCode 共用当前账号的订阅工作额度。

Gemini 提供低（`low`）、中（`medium`）、高（`high`）三个思考档位；兼容旧请求中的 `max` 时映射为 `high`。不会传送 DeepSeek 的专用 `thinking` 字段，也不会在失败时自动回退到另一个模型。

部署时在 `tora-auth` Worker 中设置加密 Secret `SHULIUYUN_API_KEY`。API Key 不放入仓库、桌面包、浏览器配置或模型目录；客户端仅使用 Tora 登录令牌。模型目录的可用状态由对应 Secret 是否配置及 ToChat 总开关决定。

## ToChat 内置 GPT-6.1 Sol

模型 ID 为 `gpt-6.1-sol`，思考强度提供 `low / medium / high / xhigh / max`。服务端使用枢流云的 `/v1/responses`，将流式文本和函数调用转换为 Tora 已使用的消息格式。工具继续请求保留上游返回的加密 reasoning 项；不将加密内容显示为聊天正文。

该模型只使用独立 Secret `SHULIUYUN_GPT_API_KEY`。本次用户选择保留专用密钥当前的 **default** 分组；实际调用日志已验证为 default，不能标为 codex 0.07 的价格。若以后改用 codex 0.07，应在枢流云令牌设置中固定选择该分组并关闭自动分组、跨分组重试。分组由枢流云令牌设置决定，模型 ID 不能选择价格；应用不会使用 Gemini 的 `SHULIUYUN_API_KEY` 回退调用 GPT。未配置专用 Secret 时，GPT 入口不可用。

通过少量真实调用验证流式回复、函数调用、工具结果继续请求及实际分组。平台的最终价格、上下文档位及充值换算以该平台结算规则为准，不能仅根据分组名称中的数字计算费用。

## 新增内置模型（2026-10-05）

- `gpt-6-sol`、`gpt-6-luna`、`gpt-6-astra` 复用 `SHULIUYUN_GPT_API_KEY`，通过 Responses API 转发完整函数调用与工具续写。
- `claude-opus-5` 使用独立 Worker Secret `SHULIUYUN_CLAUDE_API_KEY`，通过已实测的 OpenAI 兼容 Chat Completions 接口提供服务。
- 四款模型均已真实验证文字流式回复、函数调用及工具结果继续请求；不执行真实文件修改或外部工具。
- 思考强度支持 low / medium / high / xhigh / max，界面采用离散滑块；Gemini 仍为三档，DeepSeek 仍为原有三档。
- GPT 默认最大上下文 1,050,000；Claude 默认最大上下文 1,000,000；Gemini、DeepSeek 为 1,048,576。依据模型官方规格，渠道 `/v1/models` 未返回上下文元数据，尚未进行填满整个窗口的高成本实测。桌面压缩预算扣除输出及系统提示余量；用户明确保存的较小上下文选项继续生效。

规格来源：[OpenAI GPT-6 Sol](https://developers.openai.com/api/docs/models/gpt-6-sol)、[Luna](https://developers.openai.com/api/docs/models/gpt-6-luna)、[Astra](https://developers.openai.com/api/docs/models/gpt-6-astra)、[Claude 上下文](https://platform.claude.com/docs/en/build-with-claude/context-windows)、[Claude 思考强度](https://platform.claude.com/docs/en/build-with-claude/effort)、[Gemini](https://ai.google.dev/gemini-api/docs/models/gemini-3.8-flash/)、[DeepSeek 模型目录](https://api-docs.deepseek.com/api/list-models/)。
