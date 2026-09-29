# Tora 品牌迁移

项目展示名称、命令行、npm 工作区包名、界面、文档、邮件及官网均使用 Tora。
仓库地址为 https://github.com/ToraAgent/Tora ，官网为 https://ohfun.online 。
Cloudflare Worker 为 `tora-auth`，Pages 项目为 `tora`，新客户端接口使用
`https://tora.ohfun.online`。

## 数据兼容

- 新的数据目录为 `~/.tora`。首次运行时优先复制 `~/.cocode`，其次兼容更早的 `~/.vega`；原目录保留。
- 显式配置的 `TORA_HOME` 优先，旧 `COCODE_HOME` 仍受支持。新 `TORA_*` 环境变量优先于旧前缀。
- 浏览器偏好在主题初始化之前从旧键复制到新键，新值不被覆盖，旧键不被删除。
- 已有项目中的 `COCODE.md`、`.cocode/AGENTS.md`、项目钩子和斜杠命令仍可读取。
- 已发布桌面应用的 `com.cocode.desktop` 标识、内部 Chromium/Safe Storage 身份及合成模型凭证 ID 保留，避免丢失登录、配置与更新兼容性。应用可见名称为 Tora。

## 线上兼容

- 已安装版本继续使用的 `cocode.ohfun.online` 与 `cocode-ai.ohfun.online` 作为兼容域名保留，绑定到同一个 Tora Worker。
- 当前 D1 仍使用已有数据库 ID。数据库物理名称及 Pages 的原始 `pages.dev` 子域名在 Cloudflare 中不能直接改名。
- 历史 v1.0.0 / v1.0.1 安装包和更新元数据保持原文件名、签名及哈希；发行说明明确标注历史构建。下一次新构建会按 `productName: Tora` 产生新文件名。
- 发信显示名为 Tora，使用已验证的 `noreply@ohfun.online`。

## 验证

核心与 ASAPI 测试、前端 TypeScript/Vite 构建、隔离 UI 冒烟测试，以及数据/偏好迁移测试覆盖本次改名。
未重新构建、签名或上传新的桌面安装包；不要把源码中的新名称当作已安装旧版本已升级的证据。
