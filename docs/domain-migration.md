# Cognitic 域名迁移（2026-10-23）

- 官网：`https://cogniticteam.com`，`www.cogniticteam.com` 由海外服务器转到主域名。
- 账号、官方模型、语音与管理 API：`https://api.cogniticteam.com`。
- 邮件按用户要求继续使用 `noreply@ohfun.online`、`support@ohfun.online`、`join-us@ohfun.online`。
- 新客户端默认地址、CSP、官网链接和文档使用新域名；启动迁移只改已保存的旧官方 API 地址，不覆盖自定义地址。
- `tora.ohfun.online`、`cocode.ohfun.online` 保留旧客户端 API 兼容，使用同一海外服务器上的独立旧库实例。旧官网入口在海外服务器跳转到主域名。
- 网页版 ToChat 使用海外服务器的系统 DNS 解析自定义模型和网页地址，并使用查验过的地址建立 HTTPS 连接。
- 通行密钥按所属 RP 验证，旧密钥保留在旧域名，新注册使用新 RP。详见 `auth-passkeys.md`。
- 热更新清单使用签名的相对包路径，在新旧入口分别解析到同源地址。包内容、构建号、摘要和信任公钥不变；不允许跨域包地址。
- 旧官网 ToChat 的浏览器本地历史仍属于旧 origin，不自动跨域搬运；旧站兼容入口继续可用。域名改动本身不修改服务器账号、订阅、用户对话或模型渠道密钥。

本次没有发布新的桌面安装包。已安装旧版本继续通过旧 API 兼容入口工作；新客户端源码和本地构建使用新 API。
