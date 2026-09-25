# macOS 签名与公证

CoCode 的 macOS 应用使用 Developer ID Application 证书签名并经 Apple 公证。`packages/desktop/package.json` 同时生成 DMG（手动安装）与 ZIP（应用内自动更新）；两个文件和 `latest-mac.yml` 必须来自同一次构建，并在发布时一起上传。不要发布仅签名、尚未公证的应用。

## 在本机生成可分发版本

1. 确认登录钥匙串里有 `Developer ID Application` 身份：

   ```sh
   security find-identity -v -p codesigning
   ```

2. 在 [Apple 账户](https://account.apple.com/)的“登录与安全性 → App 专用密码”创建一枚专用于 CoCode 公证的密码。不要把 Apple 账户密码、App 专用密码或 `.p12` 文件提交到仓库，也不要发到聊天中。

3. 在自己的终端运行以下命令，把公证凭据交互式存入本机钥匙串。命令会提示输入 App 专用密码；不要将密码写在命令行里。将邮箱替换为开发者账户的 Apple ID：

   ```sh
   xcrun notarytool store-credentials cocode-notary --apple-id "你的 Apple ID 邮箱" --team-id WR54859WSF
   ```

4. 构建、签名并公证应用，再制作 DMG、ZIP 和更新元数据（不会上传 GitHub）：

   ```sh
   APPLE_KEYCHAIN_PROFILE=cocode-notary npm run dist:mac -w @cocode/desktop
   ```

5. 若还要求 DMG 容器本身带签名与离线公证票据，可单独签名、公证并附票据。把下列签名身份替换为本机 `security find-identity` 中的 Developer ID Application；`notarytool` 必须返回 `Accepted` 才继续：

   ```sh
   DMG=packages/desktop/release/CoCode-1.0.0-mac.dmg
   codesign --sign "Developer ID Application: 你的名字 (TEAM_ID)" --timestamp --identifier com.cocode.desktop.dmg "$DMG"
   xcrun notarytool submit "$DMG" --keychain-profile cocode-notary --wait
   xcrun stapler staple "$DMG"
   npm run refresh:mac-metadata
   ```

   最后一步重建 DMG 的 `*.blockmap` 和 `latest-mac.yml`。签名和附票据会改变 DMG 文件；不能发布构建时生成的旧校验值。ZIP 不应在生成元数据后重新压缩或修改。

6. 发布前检查应用、ZIP 与最终 DMG：

   ```sh
   codesign --verify --deep --strict --verbose=2 packages/desktop/release/mac-universal/CoCode.app
   spctl --assess --verbose --type exec packages/desktop/release/mac-universal/CoCode.app
   xcrun stapler validate packages/desktop/release/mac-universal/CoCode.app
   unzip -t packages/desktop/release/CoCode-1.0.0-mac.zip
   codesign --verify --verbose=2 packages/desktop/release/CoCode-1.0.0-mac.dmg
   spctl --assess --verbose --type open --context context:primary-signature packages/desktop/release/CoCode-1.0.0-mac.dmg
   xcrun stapler validate packages/desktop/release/CoCode-1.0.0-mac.dmg
   hdiutil verify packages/desktop/release/CoCode-1.0.0-mac.dmg
   ```

   应用和最终 DMG 的 `spctl` 都应显示 `accepted`，来源为 `Notarized Developer ID`。若构建日志显示跳过应用公证，或 `spctl` 显示 `Unnotarized Developer ID`，请勿对外发布。上传 GitHub Release 时至少包含同一构建的 DMG、ZIP、`latest-mac.yml`；缺少 ZIP 或元数据，macOS 自动更新将失败。更新功能只能通过安装低于发布版本的已签名应用进行端到端验证，例如从 1.0.0 升级到 1.0.1。

## GitHub Actions 发布

推送 `v*` 标签（`v1.0.0` 除外）会触发 `.github/workflows/release-desktop.yml`，自动发布 DMG、ZIP 与更新元数据。`v1.0.0` 由本机签名、公证并附票据后手动上传，避免 CI 覆盖最终 DMG 与更新元数据。后续 macOS 发布任务要求先在仓库 Secrets 中配置：

| Secret | 内容 |
| --- | --- |
| `MAC_CSC_LINK` | 从钥匙串导出的、包含 Developer ID Application 证书及私钥的加密 `.p12` 文件的 Base64 内容 |
| `MAC_CSC_KEY_PASSWORD` | 上述 `.p12` 的导出密码 |
| `APPLE_ID` | 开发者账户 Apple ID 邮箱 |
| `APPLE_APP_SPECIFIC_PASSWORD` | 公证专用的 App 专用密码 |
| `APPLE_TEAM_ID` | Apple Developer Team ID |

缺少任何一项时，macOS 发布任务会直接失败，防止误发未签名或未公证的应用。`.p12` 仅供受信任的发布环境使用；本机日常构建不需要导出私钥。CI 中 electron-builder 会签名、公证应用，但不会执行上面可选的 DMG 容器二次签名；若需要它，必须先完成这一步并重建元数据，再上传最终文件。Windows 发布任务仍依赖 macOS 发布任务成功。
