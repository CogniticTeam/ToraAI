# 火山方舟豆包官方聊天模型

模型 ID：`doubao-seed-2-1-lite-260915`，显示为 **Doubao Seed 2.1 Lite**。

- 仅供 ToChat **聊天**模式使用，无需订阅，不消耗 Agent Credits。
- ToChat 工作模式和 ToCode 隐藏该官方模型；本地运行配置、官网代理和官方服务均会拒绝越界调用。
- 上下文窗口为 1,048,576 Tokens，沿用最大上下文预算；现有回复长度上限保持不变。
- 支持文字、JPEG/PNG/WebP/GIF 图片，WAV/MP3/FLAC/AAC/M4A 音频及 MP4/MOV/AVI 视频。
- 音频最多 10 MB，视频最多 20 MB，每次请求最多 4 个音频或视频附件；图片沿用桌面 32 MB、网页 8 MB 的单文件限制，请求总大小仍受现有上限约束。
- 思考强度提供低、中、高三档，保留原有选择界面。视频按 1 FPS 采样。

## 服务端配置

将独立上游密钥配置为 Worker Secret `ARK_API_KEY`。客户端只使用 Tora 登录凭证，不保存或接收该密钥。

```sh
npx wrangler secret put ARK_API_KEY
```

上游固定为 `https://ark.cn-beijing.volces.com/api/v3/responses`。服务端将现有聊天消息、附件和联网函数调用转换为方舟 Responses 请求，再将 SSE 转回 Tora 的聊天事件。方舟不支持 OpenAI 的 `reasoning.summary` 配置，所以使用独立适配分支；多轮调用保留加密的思考上下文。请求使用 `store: false`，标题请求关闭思考并独立限流。

参考：[模型列表](https://docs.volcengine.com/docs/82379/1553576?lang=zh)、[Responses API](https://docs.volcengine.com/docs/ark/create-model-responses-api?lang=zh)、[参数支持表](https://docs.volcengine.com/docs/ark/model-parameter-support?lang=zh)。
