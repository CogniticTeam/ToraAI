# Issues 提交注意事项

本说明适用于 ToraAI 仓库中的 Tora 应用、CLI、模型接入和相关工具。中文与英文反馈均可。Issues 用于可追踪的问题与建议，一般使用求助请到 [Discussions](https://github.com/CognitictTeam/ToraAI/discussions)。

## 提交前

- 搜索现有的开放及已关闭议题，相同问题请在原帖补充新的复现信息。
- 核对版本与系统支持范围。报告旧版本问题时注明版本及未更新的原因。
- 一份议题围绕一个主题：多个故障或互不相关的需求应分开提交。
- 选择合适的表单：Bug 反馈、崩溃/卡死、新功能提案或优化建议，不要使用无关分类。

## 让问题能够被复现

提供应用版本、操作系统与架构、完整操作顺序、实际结果和预期结果。模型相关问题请补充官方/自定义来源、服务商、模型名、运行模式和非敏感错误码；网络相关问题说明是否使用代理及错误发生环节，不要提交代理密码或私人服务器信息。

描述“点了什么、发生了什么”，不要只写“打不开”“不能用”。尽量用最小示例重现；如果偶发，请说明频率。功能提案应解释使用场景、当前困难和验收标准，优化建议应给出可检查的改善目标。

## 诊断材料与隐私

可附错误文字、截图、录屏、系统崩溃报告或运行日志。如果没有日志或不知道如何获取，请说明情况，维护者可以协助确认需要的材料。不要为了复现而删除未备份的用户数据。

发布前检查附件、图片和代码块，移除 API Key、密码、登录令牌、Cookie、邮箱等账户信息，以及私人对话、工作区文件内容、个人目录和私有端点。不要上传整个配置文件、会话数据库、项目目录或 `.env`。

安全漏洞和凭据泄露不要在公开议题中披露细节。泄露的凭据应先撤销或轮换；私下报告渠道尚未明确时，可先提交不含漏洞细节的联系请求。仅删除公开内容不能替代凭据轮换。

## 讨论与处理

保持尊重、紧扣主题；比较其他工具时说明与问题直接相关的具体差异。避免刷屏、攻击、重复催促或在一个议题中不断追加其他需求。

维护者会根据影响范围、复现情况和开发成本评估优先级，议题提交不构成接受提案或完成期限的承诺。需要补充信息时，请在原帖回复；长期缺少必要信息、重复或明确超出项目范围的内容，可能被说明原因后关闭。有新的证据仍可在原帖补充。

## 标签说明

新表单会自动带上 `新提交`，并按类别附加 `bug` 或 `enhancement`。后续标签由维护者整理，不需要提交者自行判断优先级。

- 优先级与进度：`❗重要`、`⏳等待处理`、`➡️计划之中`、`🔨正在处理`、`👌已完成`。
- 补充与协作：`🗨更多细节`、`🔄️需要复现`、`🗨需要讨论`。
- 暂停与等待：`⏸暂停`、`⏸等待`。
- 关闭或外部原因：`🔁重复`、`❌无法复现`、`❌暂无计划`、`❌拒绝/放弃`、`❌第三方引起`、`❌网络问题`、`❌超时`、`🚫违规`。
- 风险与试验：`💥破坏性`、`🧪实验性`。

`👌已完成` 表示相关改动已完成，不一定已经包含在当前发行包中；实际可用版本以 Release 为准。现有英文标签会继续保留，供维护者、依赖更新和代码贡献使用。

## English summary

Search existing issues first and report one topic per issue. Include the application version, platform, reproduction steps, expected/actual behavior and redacted evidence. For model issues, include the provider, model and application mode, never your API key. Use Discussions for general support. Feature requests need a concrete use case and acceptance criteria. Keep discussion respectful; there is no guaranteed response or delivery deadline. Report vulnerabilities privately and revoke exposed credentials before sharing further information.
