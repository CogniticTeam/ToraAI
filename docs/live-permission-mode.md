# 对话中途修改权限模式

桌面 ToCode、ToChat 工作模式，以及官网 ToChat 工作模式支持在任务运行或等待审批时修改权限设置。

- 桌面会话 `PATCH /sessions/:id` 在运行时仅接受单独的 `permission_mode` 字段，校验五种现有模式；模型、工作目录及其它配置继续在运行时返回 409。
- 每次工具权限判断读取最新会话模式。等待审批的工具重新判断，不会重新运行项目钩子；明确拒绝规则、钩子强制审批和首次 Computer 同意均保留。
- 模式修改以 `state_updated` 通知前端；自动恢复或拒绝的审批通过确认结果事件清除旧卡片。修改在任务收尾、历史恢复后仍然保留。
- 子代理遵守最新队长模式和原本分配权限的交集；重新判断挂起的子代理审批，并清除旧卡片。
- 已经开始执行的操作继续完成，新模式用于后续权限判断，不回滚既有文件修改。
- 网页工作模式仅控制已授权目录中的修改是否逐次确认；浏览器目录授权和目录边界检查继续生效。

验证：`node --test packages/core/test/live-permission-mode.test.mjs`、`node --test scripts/test-review-frontend.mjs`、`node packages/core/test/asapi.js`。
