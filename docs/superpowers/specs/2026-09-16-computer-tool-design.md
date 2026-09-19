# Computer 工具设计（桌面级 Computer Use）

- 日期：2026-09-16
- 状态：已实现并验证
- 范围：新增内建 `Computer` 工具（13 个 action），不改动 Browser / 权限系统既有行为

## 1. 背景与定位

用户需求：让 Agent 能"看屏幕 + 控制鼠标键盘"，操作任意原生应用（桌面级 computer use）。

与既有能力的分工：

| 能力 | 适用场景 |
| --- | --- |
| WebFetch | 抓静态页面文本，快、省 token |
| Browser（内置 webview） | 浏览器内页面操作，选择器级精准 |
| **Computer（本次新增）** | 桌面任意原生 App：Finder、系统设置、非浏览器应用 |

## 2. 方案选型

选型时实测排除的路径：

- Node 原生模块（robotjs/nut.js）：需要 node-gyp 编译链，本机 swift/python3 被 Xcode license 挡住 → 放弃
- cliclick 外部二进制：未安装，要求用户 brew 装软件违背零依赖原则 → 放弃
- **JXA + CoreGraphics（osascript -l JavaScript 桥接 CGEvent）：macOS 内建、零依赖、毫秒级延迟** → 采用

## 3. 架构

```
模型 → Computer.execute(args)
         ├─ 看类动作 ── 直接执行
         ├─ 写类动作 ── hasAccessibility() 探测（30s 缓存）→ 执行
         └─ 错误 ── cleanOsaErr() 识别辅助功能权限错误 → 返回设置路径

底层通道（全部 macOS 内建）：
  position/move/click/drag/scroll → JXA + CoreGraphics（CGEvent 合成）
  type                            → CGEventKeyboardSetUnicodeString 分块注入（≤20 UTF-16/块，中文可用）
  key                             → AppleScript key code（键名→硬件键码表）+ modifiers
  screen_info                     → JXA + NSScreen（frame/visibleFrame/backingScaleFactor）
  windows/window_*                → AppleScript System Events（AXPosition/AXSize/AXRaise）
  screenshot                      → screencapture -x -C -D n + sips 缩回逻辑尺寸
```

### 关键决策

1. **Retina 坐标 1:1**：screencapture 输出 2x 物理像素，用 sips 缩回 NSScreen 的逻辑尺寸。
   模型从截图量出的坐标 = click/move 的坐标，无需换算。实测 1800×1169 输出正确。
2. **type 不用 AppleScript keystroke**：keystroke 发不了中日韩字符；CGEventKeyboardSetUnicodeString
   才能输入中文（文本经 JSON.stringify 嵌入 JXA 脚本，天然防注入）。
3. **写动作前探测辅助功能**：CGEventPost 缺权限时**静默丢事件**（无报错无效果）——
   比报错更糟。故写动作前跑一次 System Events 探测（结果缓存 30s），缺权限直接返回设置路径。
4. **多屏全局逻辑坐标**：主屏左上角 (0,0)，副屏可为负坐标；CGEvent 天然工作于此坐标系，
   点击不需指定屏幕；screenshot 用 screen 参数（0=主屏）+ screencapture -D。

## 4. 动作清单（13 个）

| action | 类型 | 参数 | 说明 |
| --- | --- | --- | --- |
| screenshot | read | screen | 截屏（多模态返回图像） |
| position | read | — | 读指针位置 |
| screen_info | read | — | 列显示器（坐标/尺寸/可用区/缩放） |
| windows | read | app/title/limit | 列可见窗口（应用/标题/位置/大小） |
| click | write | x/y/button/clickCount | 单击/双击/右键/中键 |
| drag | write | fromX/fromY/toX/toY | 24 步插值拖拽（~0.4s） |
| scroll | write | direction/amount | 四向滚动（行单位） |
| type | write | text | 输入文本（支持中文，上限 5000 字符） |
| key | write | key/modifiers | 按键（Enter/F1/cmd+shift…） |
| move | write | x/y | 移动指针 |
| window_focus | write | app + index/title | 置前 + AXRaise |
| window_move | write | app + x/y | 移动窗口 |
| window_resize | write | app + w/h | 调整窗口大小 |

用户决策记录：功能增补时明确只选了"多显示器支持"与"窗口管理"，**未选** paste/wait/app 动作。

## 5. 安全模型

- **应用层**：`toolCategory('Computer', {action})` → 看=read、操作=write（经 builtin.js 注册，
  写动作走既有确认卡流程）；别名 computer/desktop/screen/mouse/keyboard 归一到 Computer。
- **系统层**：需用户在系统设置授权——「辅助功能」（合成事件/读窗口）+「屏幕录制」（截屏）。
  授权对象是 CoCode 应用（osascript 子进程经 TCC 归因到父应用）。
- 不经过 shell 执行（spawn 参数数组）；AppleScript 字符串统一 asq() 转义；JXA 文本用 JSON.stringify 嵌入。

## 6. 验证记录（2026-09-16）

- 7 项 JXA 探针全过：结构体传参、可变参双轮滚动、Unicode 键盘注入、NSScreen 枚举、System Events 权限
- node --check：computer.js / builtin.js / index.js 全过
- 从 index.js 导入（完整模块图）→ builtinTools 含 Computer（共 20 工具）
- 权限分类：4 read + 9 write 全部正确
- 实测只读动作：position / screen_info（1800×1169 Retina 2x）/ windows（列出 Canva 窗口）/ screenshot
- 截图落盘核验：1800×1169 逻辑尺寸正确，画面清晰可读
- 错误路径：未知 action、click 缺坐标、key 未知键名、window_focus 缺 app、type 超长，文案均带下一步指引

## 7. 已知边界

- 仅 macOS；非 darwin 平台返回明确提示
- 副屏顺序映射：NSScreen 序号 ↔ screencapture -D 序号（主屏优先，实践中一致）
- 部分安全输入框（密码框）、游戏会拒绝合成事件——属系统限制，如实失败不假成功
