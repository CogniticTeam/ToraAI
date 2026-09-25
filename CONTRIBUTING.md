# 贡献指南 / Contributing to CoCode

[简体中文](#简体中文) · [English](#english)

## 简体中文

感谢你愿意帮助改进 CoCode！无论是报告问题、改进文档，还是提交代码，我们都欢迎。

### 开始之前

- 请先搜索现有 Issue 和 Pull Request，避免重复工作。对于较大的功能或架构调整，建议先开 Issue 讨论方案。
- 报告问题时，请提供 CoCode 版本、操作系统、复现步骤、预期与实际结果。可以附截图或日志，但请先删除其中的密钥、令牌、邮箱等个人信息。
- 安全问题或泄露的凭据不要放在公开 Issue 中；请通过私下渠道联系维护者。

### 开发与验证

建议使用与 CI 一致的 Node.js 24 和 npm。在仓库根目录运行：

```bash
npm ci
npm ci --prefix packages/desktop/frontend
npm test
npm run test:desktop-security
npm run test:bundle
npm run build:ui -w @cocode/desktop
```

改动前端交互时，请按需运行 `npm run test:ui` 并手动检查相关页面。普通代码贡献不需要 Apple 签名或公证凭据；正式安装包由维护者构建。

主要目录：`packages/core` 是 Agent 引擎，`packages/desktop` 是桌面应用，`packages/cli` 是终端版，`packages/auth-worker` 是可选云服务，`website` 是官网。

### 提交 Pull Request

1. 从最新的 `main` 创建分支，让每个 PR 聚焦一个问题或一组紧密相关的改动。
2. 说明改动原因、行为变化和验证方式。界面改动请附更新前后的截图；API 或数据结构改动请说明兼容性与迁移方式。
3. 为修复的问题和新增行为补充相应测试。若修改了用户可见文案，请同步检查中文和英文。
4. 提交前检查差异，避免顺带提交无关格式化、构建产物或个人配置。

**不要提交** API Key、密码、会话令牌、`.env`、`.dev.vars`、用户数据、`.wrangler` 状态、`node_modules` 或 `release` 安装包。如果凭据意外进入提交，请立即撤销或轮换凭据；仅从最新提交中删除它并不足以消除泄露风险。

本项目采用仓库中的 [AGPL-3.0 许可证](LICENSE)。提交代码前，请确认你有权按该许可证贡献相关内容。

## English

Thank you for helping improve CoCode! Bug reports, documentation updates, and code contributions are all welcome.

### Before you start

- Search existing issues and pull requests first. For substantial features or architectural changes, open an issue to discuss the approach before implementation.
- For bug reports, include the CoCode version, operating system, reproduction steps, expected behavior, and actual behavior. Redact keys, tokens, email addresses, and other personal information from screenshots and logs.
- Do not disclose security issues or exposed credentials in a public issue; contact the maintainers privately.

### Development and checks

Use Node.js 24 and npm, matching CI. From the repository root, run:

```bash
npm ci
npm ci --prefix packages/desktop/frontend
npm test
npm run test:desktop-security
npm run test:bundle
npm run build:ui -w @cocode/desktop
```

For frontend interaction changes, run `npm run test:ui` when applicable and manually check the affected screens. Apple signing and notarization credentials are not needed for ordinary contributions; maintainers produce release installers.

The main directories are `packages/core` (Agent engine), `packages/desktop` (desktop app), `packages/cli` (terminal edition), `packages/auth-worker` (optional cloud service), and `website` (official site).

### Pull requests

1. Branch from the latest `main` and keep each PR focused on one problem or a closely related set of changes.
2. Explain why the change is needed, what behavior changes, and how you verified it. Include before-and-after screenshots for UI changes; describe compatibility and migrations for API or data changes.
3. Add tests for fixes and new behavior. Check both Chinese and English when changing user-facing text.
4. Review the diff before submission. Avoid unrelated formatting changes, generated files, and personal configuration.

**Never commit** API keys, passwords, session tokens, `.env`, `.dev.vars`, user data, `.wrangler` state, `node_modules`, or `release` installers. If a credential is accidentally committed, revoke or rotate it immediately; removing it from the latest commit alone does not undo the exposure.

This project uses the repository's [AGPL-3.0 license](LICENSE). Please make sure you have the right to contribute your work under that license.
