# 从 Codex / Claude Code 导入会话

此功能仅在 Tora 桌面版提供，入口为左下角账户菜单 → **导入聊天记录**。

1. 选择“扫描本机 Codex”或“扫描本机 Claude Code”，也可以手动选择 JSON / JSONL 文件。
2. 选择记录并预览。预览显示来源、标题、消息数量、原始时间、项目来源，以及开头和末尾的文字消息。
3. 选择 ToCode / ToChat 和目标智能体，点击导入。导入完成后打开新会话；继续使用时选择当前模型和项目目录。

Codex 扫描 `~/.codex/sessions` 和 `~/.codex/archived_sessions`，遵循已有 `CODEX_HOME`；Claude Code 扫描 `~/.claude/projects`，遵循已有 `CLAUDE_CONFIG_DIR`。扫描仅在用户主动点击时发生。

记录在本机解析并保存，不上传到官网或外部模型。导入创建新的 Tora 会话，保留原文件和已有会话；相同内容重复导入会跳过。Codex 的事件/响应镜像按轮次去重；Claude Code 的分段文本回复合并，重复快照不重复插入。

迁移内容是用户与助手的文字、标题和原始时间。系统/开发者指令、思考、工具调用状态、权限规则和模型凭证不迁移；不能迁移的附件与损坏行会在预览中说明。源目录只保留为来源信息，不作为当前工具执行目录。缺少时间的消息在导入时使用当前时间，并显示对应提示。导入的工具记录不会执行。

本机扫描显示最近 300 个文件。单次最多 100 个文件，每文件最多 32 MB、总计最多 64 MB；选择与预览在 20 分钟后过期。预览内容是本次读取的快照，之后修改的源文件不会悄悄改变已确认的导入数据。

实现：`packages/core/src/session-import.js` 解析格式；`packages/core/src/asapi/session-import.js` 管理扫描、预览与新增存储；`SessionImportDialog.tsx` 提供桌面入口。恢复本次修改可参考 `.backups/session-import-20261003/`，不要用 Git 强制重置覆盖其他未提交工作。

验证命令：

```sh
node --test packages/core/test/session-import.test.mjs
node packages/core/test/asapi.js
node scripts/test-multilingual.mjs
npm run build:ui -w packages/desktop
```

自动化用例与界面测试均使用临时数据根、合成会话及模拟模型；没有迁移或修改用户的真实 Codex / Claude Code 会话。
