# CoCode 消息与账户管理

后台页面地址：<https://ohfun.online/admin>，由官网 Cloudflare Pages 项目 `cocode` 托管。`website/admin.html` 和 `website/admin.js` 通过跨域请求调用 `https://cocode.ohfun.online/admin/*` 的 Worker 接口；旧 Worker 页面地址自动跳转到官网。管理员输入 Worker 的 `ADMIN_TOKEN` 管理密钥登录。密钥只保留在当前页面内存中，刷新或退出后需重新输入；不要放入客户端、仓库或分享给普通用户。

后台支持按用户名/邮箱搜索、定向/全体消息、封禁原因、封禁和解封。消息存入 D1，用户从账户菜单的「消息」查看，打开单条消息后标为已读。`admin_audit` 保存管理操作记录。

「已发送消息」支持确认后撤回。新消息以 `batch_id` 标记发送批次，群发整批撤回；既有无批次的历史消息逐条撤回，避免误撤回同名通知。撤回软删除并保留审计，用户列表、未读计数、详情、翻译接口均排除撤回内容，同时清理译文缓存并实时通知客户端。离线客户端恢复后同步；已阅读的内容和用户自行保存的副本无法收回。

实时同步使用 `ACCOUNT_EVENTS` Durable Object 的 WebSocket 休眠连接。客户端用登录令牌换取有效期 30 秒的一次性连接票据；封禁不销毁会话，保留状态和消息通道，因此解封后能自动恢复。模型、语音、账户修改等接口会拒绝封禁账户。新版桌面客户端同时暂停运行中的 Agent 并锁定本地写入和新任务；断线时短轮询补偿，恢复连接后同步状态。

## 部署

发送给「全部账户」时，可勾选「新用户可收到消息」（默认关闭）。启用的通知保存在 `message_campaigns`，通过 D1 注册触发器在新用户创建的同一事务中投递一次；不追溯投递未勾选的历史消息。定向消息禁止启用。撤回同时关闭后续投递并隐藏已投递副本；即使当前没有账户，也可发布和撤回面向新用户的通知。无需更新客户端即可接收新用户消息。

```sh
npx wrangler pages deploy website --project-name cocode --branch main
npx wrangler secret put ADMIN_TOKEN --config packages/auth-worker/wrangler.toml
npx wrangler deploy --dry-run --config packages/auth-worker/wrangler.toml
npx wrangler deploy --config packages/auth-worker/wrangler.toml
```

`ADMIN_TOKEN` 应使用至少 32 字节密码学随机值。既有 `RESEND_API_KEY`、`TURNSTILE_SECRET`、`ZHIPU_API_KEY` 继续通过 Worker Secrets 管理。首次部署自动添加消息、管理审计、连接票据表以及账户封禁字段；部署前应导出 D1 备份。请将备份存放于仓库外，并限制文件访问权限。

## 本地验收

用隔离数据库启动 Wrangler，调用 `/health` 初始化表，然后导入 `test/admin-fixture.sql`：

```sh
npx wrangler dev --config packages/auth-worker/wrangler.toml --port 8791 --persist-to /private/tmp/cocode-admin-worker-test-20260921 --var ADMIN_TOKEN:local-test-admin
curl http://127.0.0.1:8791/health
npx wrangler d1 execute cocode-auth --local --config packages/auth-worker/wrangler.toml --persist-to /private/tmp/cocode-admin-worker-test-20260921 --file packages/auth-worker/test/admin-fixture.sql
node packages/auth-worker/test/admin-integration.mjs
node scripts/test-account-ui.mjs
```

本地 fixture 不得用于线上。`scripts/test-account-live.mjs` 需要显式环境开关及仓库外管理凭证文件，只创建随机测试账户、对该账户定向发送和封禁，不向真实用户发送消息，并在 finally 中清理测试数据。

## 消息翻译

每条消息可按应用语言中英互译，同时翻译标题和正文，并可切回原文。同语言或无可识别文字的消息不会请求模型。中英混合内容根据正文的主要文字判定语言，链接、代码和常见产品名不计入判定。

Worker 的 `/account/messages/translate` 仅接受消息 ID 和 `zh` / `en`，校验当前用户的消息归属。固定使用智谱 `glm-5.3-flash`，独立密钥通过 `npx wrangler secret put MESSAGE_TRANSLATION_API_KEY --config packages/auth-worker/wrangler.toml` 设置，不影响语音识别密钥。译文按消息和目标语言缓存在 D1，每账户每小时最多 30 次未缓存调用，不扣除用户积分。可运行 `node --test packages/auth-worker/test/message-translation.test.mjs` 验证语言组合、权限、缓存、限流及上游错误处理。

## 更新与客户端发布

正式安装包启动时立即检查 GitHub 最新正式 Release。确认新版后显示不可跳过的更新界面，并阻止新任务；无新版或检查暂时不可用时不弹窗。macOS 打开官网 `https://ohfun.online/#download`，用户下载 DMG 并替换；Windows 使用 electron-updater 下载，完成后要求重启安装，失败可重试。开发模式不执行版本检查。

后端发布不会改变用户已安装的客户端。消息入口、实时封禁、原生菜单和强制更新界面需要使用本次客户端代码重新构建并发布后生效。

## 投票

桌面客户端左侧「投票」入口显示已发布、当前账户可参与的活动；管理员在本页面管理草稿、发布、下架、置顶、归档、用户组、明细与导出。单选、多选、百分制打分及每人一次／每日一次／不限次数均由 Worker 校验。每日限制按北京时间自然日计算。用户端离线提交先保存在本机待同步队列，联网后重试；只有 Worker 返回成功才算投票成功。发布后选项和投票规则冻结，结束前仍可修改标题、简介、封面、备注并延长截止时间。已删除活动与违规票保留审计记录。

结果可设为实时公开、结束后公开或仅管理员可见；「公开参与人数」和「公开各选项数据」分别控制客户端展示。管理端以 ECharts 绘制柱状图和环形图，支持保存截图，汇总和用户明细以 XLSX 导出。导出只保留有效票，超过 5 万条时会拒绝一次性导出，以免 Worker 内存耗尽。

防刷功能默认关闭。启用 IP 或设备限制前，需设置只存在 Worker Secrets 的 `POLL_FRAUD_SECRET`。Worker 用 HMAC 散列指纹，数据库不保存原始 IP 或设备标识；IP 限制会影响共享网络，客户端设备标识可重置，因此这两项是辅助限制，不是可靠的身份认证。账户身份和参与次数始终由服务端会话、D1 约束校验。

线上部署顺序：先将 D1 导出到仓库外，再执行 `migrations/0001_polls.sql`，设置密钥，最后部署 Worker 和官网 Pages。迁移脚本可重复执行；Worker 冷启动也会检查缺失表。不要将本地测试 fixture 导入线上。

```sh
npx wrangler d1 export cocode-auth --remote --config packages/auth-worker/wrangler.toml --output /path/outside/repository/d1-before-polls.sql
npx wrangler d1 execute cocode-auth --remote --config packages/auth-worker/wrangler.toml --file packages/auth-worker/migrations/0001_polls.sql
openssl rand -hex 32 | npx wrangler secret put POLL_FRAUD_SECRET --config packages/auth-worker/wrangler.toml
npx wrangler deploy --config packages/auth-worker/wrangler.toml
npx wrangler pages deploy website --project-name cocode --branch main
```

本地验收使用隔离的 Wrangler dev 和 `test/admin-fixture.sql`：`node packages/auth-worker/test/polls-integration.mjs` 验证权限、投票限制、结果、导出与防刷；`node scripts/test-polls-admin-ui.mjs` 验证管理页。发布 Worker 和 Pages 不会自动更新已安装的桌面客户端；投票入口需在下一版客户端发布后出现。
