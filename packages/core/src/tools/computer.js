// Computer 工具：桌面级 computer use —— 截屏看屏幕 + 鼠标键盘控制任意应用。
//
// 与 Browser 的分工：Browser 操作内置 webview（页面内精准选择器）；Computer
// 操作整个桌面（Finder、系统设置、任何原生 App）。浏览器里的页面操作优先用
// Browser —— 选择器比"截图猜坐标"精确得多。
//
// 实现走 macOS 内建能力，零依赖：
//   · 鼠标类（position/move/click/drag/scroll）走 JXA + CoreGraphics
//     （osascript -l JavaScript 桥接 CGEvent）—— 毫秒级延迟，坐标精确；
//   · type 走 CGEventKeyboardSetUnicodeString（≤20 UTF-16 单位分块注入），
//     AppleScript 的 keystroke 发不了中日韩字符，这条路才能输入中文；
//   · key 走 AppleScript key code（键名 → 硬件键码表），修饰键由系统合成；
//   · screen_info 走 NSScreen，windows/window_* 走 System Events（AXPosition/AXSize）；
//   · screenshot 走 screencapture + sips：Retina 截图是 2x 物理像素，
//     缩回逻辑尺寸后**图像坐标与点击坐标 1:1 对应**，模型看图点图即可。
//
// 权限分两层：
//   · 应用层：写动作在 toolCategory 归为 write，走确认卡（computerIsWrite）；
//   · 系统层：合成鼠标键盘事件、读取窗口树需要「辅助功能」；截屏需要「屏幕
//     录制」。缺权限时 CGEventPost 会**静默丢弃**事件 —— 这是假成功，所以
//     写动作前先探测权限，缺了就直接告诉用户去哪里开。
//
// 坐标系：macOS 全局逻辑坐标，主屏左上角 (0,0)，副屏可为负坐标（多屏布局见
// screen_info）。CGEvent 天然工作在这个坐标系上，点击不需要指定是哪块屏。

import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DEFAULT_TIMEOUT_MS = 20000;
const MAX_TYPE_CHARS = 5000;

/**
 * 可用动作。screenshot/position/screen_info/windows 是"看"，
 * open 是"打开/前置应用"（响应"帮我打开 X"类请求的首选），
 * click/drag/scroll/type/key/move 是"操作指针与键盘"，
 * window_focus/window_move/window_resize 是"管理窗口"。
 */
export const COMPUTER_ACTIONS = [
  'screenshot',
  'position',
  'screen_info',
  'windows',
  'click',
  'drag',
  'scroll',
  'type',
  'key',
  'move',
  'open',
  'window_focus',
  'window_move',
  'window_resize'
];

/** 写类动作（权限分类用）：会改变屏幕状态/应用输入。看类动作全部是读。 */
const WRITE_ACTIONS = new Set([
  'click', 'drag', 'scroll', 'type', 'key', 'move', 'open',
  'window_focus', 'window_move', 'window_resize'
]);

export function computerIsWrite(action) {
  return WRITE_ACTIONS.has(String(action ?? '').trim());
}

// ---------------------------------------------------------------- 底层执行

/** spawn 一个外部命令，返回 { ok, code, stdout, stderr }（参数数组，不经过 shell） */
function spawnCmd(cmd, args, { timeout = 15000 } = {}) {
  return new Promise((resolve) => {
    let proc;
    try {
      proc = spawn(cmd, args, { env: { ...process.env } });
    } catch (e) {
      return resolve({ ok: false, code: -1, stdout: '', stderr: e?.message || String(e) });
    }
    let out = '', err = '', timedOut = false;
    const timer = setTimeout(() => { timedOut = true; try { proc.kill('SIGKILL'); } catch { /* ignore */ } }, timeout);
    proc.stdout.setEncoding('utf8');
    proc.stderr.setEncoding('utf8');
    proc.stdout.on('data', (d) => { if (out.length < 400000) out += d; });
    proc.stderr.on('data', (d) => { if (err.length < 400000) err += d; });
    proc.on('error', (e) => {
      clearTimeout(timer);
      resolve({ ok: false, code: -1, stdout: out, stderr: e.message, timedOut: false, timeoutMs: timeout });
    });
    proc.on('close', (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0, code, stdout: out, stderr: err, timedOut, timeoutMs: timeout });
    });
  });
}

/** 跑一段 AppleScript / JXA */
async function osa(script, { lang = 'AppleScript', timeout = 15000 } = {}) {
  return spawnCmd('osascript', ['-l', lang, '-e', script], { timeout });
}

/** 跑一段 JXA 并返回 stdout */
async function jxa(script, timeout) {
  const r = await osa(script, { lang: 'JavaScript', timeout });
  if (!r.ok) throw new Error(cleanOsaErr(r.stderr, r));
  return r.stdout.trim();
}

/**
 * 把 osascript 的 stderr 整理成一句话；识别辅助功能权限错误。
 * meta 传 spawnCmd 的返回值（含 timedOut/timeoutMs）：stderr 为空且超时是
 * "未知错误"的主要来源 —— System Events 枚举窗口在系统繁忙时能超过 20s 被
 * SIGKILL，此时 stderr 必然为空，必须给出明确文案而不是"未知错误"。
 */
function cleanOsaErr(stderr, meta = {}) {
  const s = String(stderr ?? '').trim();
  if (/assistive access|-25211|-1719/i.test(s)) {
    return '缺少 macOS「辅助功能」权限（合成鼠标键盘事件、读取窗口都需要它）。' +
      '请到 系统设置 → 隐私与安全性 → 辅助功能，打开 CoCode（已打开就先关再开），然后重试。';
  }
  if (!s && meta.timedOut) {
    const secs = Math.max(1, Math.round((meta.timeoutMs ?? 20000) / 1000));
    return `操作超过 ${secs} 秒没有响应，已被强制终止 —— 通常是系统繁忙（System Events 枚举窗口、目标应用无响应时较慢）。` +
      '请稍等几秒重试；若反复超时，关掉部分应用后再试。';
  }
  return s.replace(/^execution error:\s*/i, '').split('\n')[0] || '未知错误';
}

function clampInt(v, lo, hi, dflt) {
  const n = Number(v);
  if (!Number.isFinite(n)) return dflt;
  return Math.max(lo, Math.min(hi, Math.round(n)));
}

/** 必须是有限数字时用，校验失败返回错误文案 */
function needNum(v, label) {
  const n = Number(v);
  if (!Number.isFinite(n)) return { err: `${label} 需要是数字坐标（先用 action="screenshot" 看屏幕再定坐标）。` };
  return { n };
}

// ---------------------------------------------------------------- 权限探测

let axCache = { at: 0, ok: false };

/**
 * 辅助功能权限探测。CGEventPost 在缺权限时会静默丢事件（无报错、无效果），
 * 比报错更糟，所以写动作前先花一次 System Events 查询确认权限在位。
 * 结果缓存 30s，避免每次点击都多跑一个进程。
 */
async function hasAccessibility() {
  if (Date.now() - axCache.at < 30000) return axCache.ok;
  const r = await osa('tell application "System Events" to get name of first application process', { timeout: 5000 });
  // 探测超时 ≠ 缺权限：缺权限时 osascript 会立即报 -25211（不会超时），
  // 超时几乎都是系统繁忙。此时放行让后续动作报真实错误，避免繁忙期误报。
  if (!r.ok && r.timedOut) return true;
  axCache = { at: Date.now(), ok: r.ok };
  return axCache.ok;
}

// ---------------------------------------------------------------- JXA 脚本片段

/** 鼠标键位 → CGEvent 类型码/按钮码 */
const MOUSE = {
  left: { down: 1, up: 2, drag: 6, btn: 0 },
  right: { down: 3, up: 4, drag: 7, btn: 1 },
  middle: { down: 25, up: 26, drag: 27, btn: 2 }
};

/** 读当前指针位置 */
function jxaPosition() {
  return `ObjC.import('CoreGraphics'); JSON.stringify($.CGEventGetLocation($.CGEventCreate($())))`;
}

/** 点击：先移过去（触发 hover），再按 clickCount 模拟连击（clickState 递增） */
function jxaClick(x, y, m, n) {
  return `ObjC.import('CoreGraphics');
var pt = {x: ${x}, y: ${y}}, BTN = ${m.btn}, DOWN = ${m.down}, UP = ${m.up}, N = ${n};
function post(t, cs) {
  var e = $.CGEventCreateMouseEvent($(), t, pt, BTN);
  if (cs > 1) $.CGEventSetIntegerValueField(e, 1, cs);
  $.CGEventPost(0, e);
}
post(5, 0);
for (var c = 1; c <= N; c++) { post(DOWN, c); post(UP, c); }
JSON.stringify($.CGEventGetLocation($.CGEventCreate($())))`;
}

/** 移动指针（不按键） */
function jxaMove(x, y) {
  return `ObjC.import('CoreGraphics');
$.CGEventPost(0, $.CGEventCreateMouseEvent($(), 5, {x: ${x}, y: ${y}}, 0));`;
}

/** 拖拽：按下 → 24 步插值拖动（~0.4s，多数应用才能识别为拖拽）→ 松开 */
function jxaDrag(fx, fy, tx, ty, m) {
  return `ObjC.import('CoreGraphics');
ObjC.import('Foundation');
var from = {x: ${fx}, y: ${fy}}, to = {x: ${tx}, y: ${ty}};
var BTN = ${m.btn}, DOWN = ${m.down}, UP = ${m.up}, DRAG = ${m.drag};
function post(t, p) { $.CGEventPost(0, $.CGEventCreateMouseEvent($(), t, p, BTN)); }
post(5, from);
$.NSThread.sleepForTimeInterval(0.06);
post(DOWN, from);
$.NSThread.sleepForTimeInterval(0.06);
var steps = 24;
for (var i = 1; i <= steps; i++) {
  post(DRAG, { x: from.x + (to.x - from.x) * i / steps, y: from.y + (to.y - from.y) * i / steps });
  $.NSThread.sleepForTimeInterval(0.012);
}
$.NSThread.sleepForTimeInterval(0.06);
post(UP, to);`;
}

/** 滚动：单位取"行"（更符合人的直觉），双轮事件同时给 dx/dy（0 即不滚） */
function jxaScroll(dy, dx) {
  return `ObjC.import('CoreGraphics');
$.CGEventPost(0, $.CGEventCreateScrollWheelEvent($(), 1, 2, ${dy}, ${dx}));`;
}

/** 输入文本：Unicode 键盘注入，≤20 UTF-16 单位分块（API 单事件上限） */
function jxaType(text) {
  // JSON.stringify 的产物是合法 JS 字符串字面量 —— 文本里任何引号/反斜杠/换行都安全
  return `ObjC.import('CoreGraphics');
ObjC.import('Foundation');
var text = ${JSON.stringify(String(text))};
var CH = 20;
for (var i = 0; i < text.length; i += CH) {
  var part = text.substr(i, CH);
  var dn = $.CGEventCreateKeyboardEvent($(), 0, true);
  $.CGEventKeyboardSetUnicodeString(dn, part.length, part);
  $.CGEventPost(0, dn);
  var up = $.CGEventCreateKeyboardEvent($(), 0, false);
  $.CGEventKeyboardSetUnicodeString(up, part.length, part);
  $.CGEventPost(0, up);
  $.NSThread.sleepForTimeInterval(0.006);
}
String(text.length);`;
}

/** 列出显示器：origin/size（逻辑）、缩放倍数、主屏标记 */
function jxaScreens() {
  return `ObjC.import('AppKit');
var ss = $.NSScreen.screens;
var out = [];
for (var i = 0; i < ss.count; i++) {
  var s = ss.objectAtIndex(i);
  var f = s.frame, v = s.visibleFrame;
  out.push({ x: f.origin.x, y: f.origin.y, w: f.size.width, h: f.size.height,
    vx: v.origin.x, vy: v.origin.y, vw: v.size.width, vh: v.size.height,
    scale: s.backingScaleFactor });
}
JSON.stringify(out)`;
}

// ---------------------------------------------------------------- AppleScript 片段

/** AppleScript 字符串转义（只用于拼 System Events 脚本，参数数组执行不经 shell） */
const asq = (s) => String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"');

/** 键名 → AppleScript key code（硬件键码，与键盘布局无关） */
const KEY_CODES = {
  return: 36, enter: 36, tab: 48, space: 49, delete: 51, backspace: 51,
  escape: 53, esc: 53, forwarddelete: 117, home: 115, end: 119,
  pageup: 116, pagedown: 121, left: 123, right: 124, down: 125, up: 126,
  f1: 122, f2: 120, f3: 99, f4: 118, f5: 96, f6: 97, f7: 98, f8: 100,
  f9: 101, f10: 109, f11: 103, f12: 111,
  '0': 29, '1': 18, '2': 19, '3': 20, '4': 21, '5': 23, '6': 22, '7': 26, '8': 28, '9': 25,
  '-': 27, '=': 24, '[': 33, ']': 30, ';': 41, "'": 39, ',': 43, '.': 47, '/': 44, '\\': 42, '`': 50
};

const MODIFIERS = {
  cmd: 'command', command: 'command',
  ctrl: 'control', control: 'control',
  option: 'option', opt: 'option', alt: 'option',
  shift: 'shift', fn: 'fn'
};

/**
 * 生成按键脚本。能映射到硬件键码的走 key code；纯 ASCII 可打印字符
 * （如 ! ? : 这类需要 shift 组合的符号）走 keystroke —— keystroke 会自己
 * 合成修饰键。都映射不上就返回 null 让上层报错。
 */
function asKeyScript(keyName, mods) {
  const k = String(keyName ?? '').trim().toLowerCase();
  if (!k) return null;
  const modList = (Array.isArray(mods) ? mods : [])
    .map((x) => MODIFIERS[String(x ?? '').trim().toLowerCase()])
    .filter(Boolean);
  const using = modList.length ? ` using {${modList.map((m) => `${m} down`).join(', ')}}` : '';
  let body = null;
  if (KEY_CODES[k] != null) {
    body = `key code ${KEY_CODES[k]}${using}`;
  } else if (/^[a-z]$/.test(k)) {
    body = `key code ${k.charCodeAt(0) - 97}${using}`;
  } else if (/^[\x20-\x7e]$/.test(k) && !modList.some((m) => m !== 'fn')) {
    // 单个 ASCII 可打印字符且不带功能修饰键：keystroke 直接打
    body = `keystroke "${asq(k)}"`;
  }
  if (!body) return null;
  return `tell application "System Events"\n${body}\nend tell`;
}

/** windows 列表：可见应用的全部窗口（标题/位置/大小），tab 分隔 */
function asWindowsScript() {
  return `tell application "System Events"
  set out to ""
  repeat with p in (application processes whose background only is false)
    try
      repeat with w in windows of p
        set pos to position of w
        set sz to size of w
        set out to out & (name of p) & "\\t" & (name of w) & "\\t" & (item 1 of pos) & "," & (item 2 of pos) & "\\t" & (item 1 of sz) & "," & (item 2 of sz) & linefeed
      end repeat
    end try
  end repeat
  return out
end tell`;
}

/** 窗口引用：app + index（1 起）或 app + title（包含匹配） */
function asWindowRef(app, index, title) {
  const t = String(title ?? '').trim();
  const idx = clampInt(index, 1, 100, 1);
  if (t) return `tell (first application process whose name is "${asq(app)}")\n  set wr to (first window whose name contains "${asq(t)}")\nend tell\n`;
  return `tell (first application process whose name is "${asq(app)}")\n  set wr to window ${idx}\nend tell\n`;
}

function asWindowOpScript(app, index, title, op, a, b) {
  return (
    asWindowRef(app, index, title) +
    `tell application "System Events"\n` +
    (op === 'focus'
      ? `  tell (first application process whose name is "${asq(app)}")\n    set frontmost to true\n    perform action "AXRaise" of wr\n  end tell`
      : op === 'move'
        ? `  set position of wr to {${a}, ${b}}`
        : `  set size of wr to {${a}, ${b}}`) +
    `\nend tell`
  );
}

// ---------------------------------------------------------------- 动作实现

/** 列窗口并把 tab 分隔文本解析成结构化数组（timeoutMs 跟随用户配置） */
async function listWindows(timeoutMs = DEFAULT_TIMEOUT_MS) {
  const r = await osa(asWindowsScript(), { timeout: timeoutMs });
  if (!r.ok) throw new Error(cleanOsaErr(r.stderr, r));
  const list = [];
  for (const line of r.stdout.split('\n')) {
    const parts = line.split('\t');
    if (parts.length < 4) continue;
    const [pos, size] = [parts[2].split(','), parts[3].split(',')];
    list.push({
      app: parts[0],
      title: parts[1],
      x: Number(pos[0]), y: Number(pos[1]),
      w: Number(size[0]), h: Number(size[1])
    });
  }
  return list;
}

/**
 * 截屏。Retina 截图是 2x 物理像素，必须缩回逻辑尺寸 —— 否则模型从图里量出
 * 的坐标直接错一倍。缩放依据 NSScreen 的逻辑 frame（截图前先查，避免竞态）。
 */
async function takeScreenshot(screenIdx) {
  const screens = JSON.parse(await jxa(jxaScreens(), 8000));
  const sc = screens[screenIdx];
  if (!sc) {
    const list = screens.map((s, i) => `  屏幕 ${i}：${s.w}×${s.h} @ (${s.x},${s.y})${s.scale > 1 ? ` Retina ${s.scale}x` : ''}`).join('\n');
    throw new Error(`没有屏幕 ${screenIdx}。当前有 ${screens.length} 块屏：\n${list}`);
  }
  const dir = mkdtempSync(join(tmpdir(), 'cocode-shot-'));
  const file = join(dir, 'shot.png');
  try {
    const cap = await spawnCmd('screencapture', ['-x', '-C', '-D', String(screenIdx + 1), file], { timeout: 12000 });
    if (!cap.ok) throw new Error(`screencapture 失败：${cleanOsaErr(cap.stderr, cap) || '退出码 ' + cap.code}`);
    // 缩回逻辑尺寸；Retina 源图是 2x，物理=逻辑×scale
    if (sc.scale > 1) {
      const rs = await spawnCmd('sips', ['-z', String(sc.h), String(sc.w), file], { timeout: 8000 });
      if (!rs.ok) throw new Error(`sips 缩放失败：${cleanOsaErr(rs.stderr, rs)}`);
    }
    const b64 = readFileSync(file).toString('base64');
    return { data_url: `data:image/png;base64,${b64}`, w: sc.w, h: sc.h, scale: sc.scale };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------- 结果呈现

/** 把动作结果整理成模型好读的一段文本（含下一步指引） */
function present(action, r) {
  switch (action) {
    case 'position':
      return `当前指针位置：(${r.x}, ${r.y})（全局逻辑坐标，主屏左上角为原点）。`;
    case 'move':
      return `指针已移动到 (${r.x}, ${r.y})。`;
    case 'open':
      return `已打开（或前置）「${r.app}」。刚启动的应用可能要一两秒就绪 —— 操作它的界面前先 action="screenshot" 看屏幕。`;
    case 'click': {
      const btn = { left: '左键', right: '右键', middle: '中键' }[r.button] || r.button;
      const times = r.clickCount > 1 ? `${r.clickCount} 连击` : '单击';
      return `已在 (${r.x}, ${r.y}) ${btn}${times}。\n\n点击后屏幕大概率变了 —— 想确认结果就再 action="screenshot" 看一眼。`;
    }
    case 'drag':
      return `已从 (${r.fromX}, ${r.fromY}) 拖拽到 (${r.toX}, ${r.toY})。`;
    case 'scroll': {
      const d = { up: '向上', down: '向下', left: '向左', right: '向右' }[r.direction] || r.direction;
      return `已${d}滚动 ${r.amount} 行。`;
    }
    case 'type':
      return `已输入 ${r.len} 个字符${r.len > 100 ? '（长文本已分块注入）' : ''}。目标输入框需要先获得焦点（通常先 click 一下）。`;
    case 'key':
      return `已按下 ${r.label}。`;
    case 'screen_info': {
      const lines = r.screens.map((s, i) => {
        const main = s.x === 0 && s.y === 0 ? '（主屏，坐标原点）' : '';
        return `  屏幕 ${i}：${s.w}×${s.h} @ (${s.x},${s.y})${main}${s.scale > 1 ? ` Retina ${s.scale}x（截图已缩回逻辑尺寸）` : ''}\n    可用区域：${s.vw}×${s.vh} @ (${s.vx},${s.vy})`;
      });
      return `共 ${r.screens.length} 块显示器（全局逻辑坐标，副屏可为负坐标；点击不需要指定屏幕）：\n${lines.join('\n')}\n\nscreenshot 可用 screen 参数指定截哪块屏。`;
    }
    case 'windows': {
      if (!r.list.length) {
        return '没有找到可见窗口（可能都被最小化了，或还没有 GUI 应用在前台）。';
      }
      const lines = r.list.map((w, i) =>
        `${i + 1}. [${w.app}] 「${w.title || '(无标题)'}」 @ (${w.x},${w.y}) ${w.w}×${w.h}`
      );
      return `共 ${r.list.length} 个窗口（序号即 window_* 动作的 index；用 app/title 参数可以筛）：\n${lines.join('\n')}`;
    }
    case 'window_focus':
      return `已把 ${r.app} 的${r.title ? `标题含「${r.title}」的` : `窗口 ${r.index}`}带到前台。`;
    case 'window_move':
      return `已把 ${r.app} 的窗口移动到 (${r.x}, ${r.y})。`;
    case 'window_resize':
      return `已把 ${r.app} 的窗口调整为 ${r.w}×${r.h}。`;
    default:
      return `${action} 完成。`;
  }
}

/** 窗口类动作失败时的指引：先列窗口再操作 */
const WINDOW_HINT = '先用 action="windows" 看看当前有哪些窗口（app 名要和列表里一致，index 从 1 开始）。';

// ---------------------------------------------------------------- 工具定义

export const computerTool = {
  name: 'Computer',
  description:
    '控制这台 Mac 的桌面：截屏看屏幕、打开/切换应用、移动/点击鼠标、拖拽、滚动、输入文字、按快捷键、管理任意应用的窗口。' +
    '用户让你打开/启动/切换某个应用（如"帮我打开微信"）时，优先用本工具 action=open，不要用 Bash 跑 open 命令。' +
    '适合操作原生 App（Finder、系统设置、终端、任何浏览器外的应用）；浏览器内的页面操作优先用 Browser 工具（选择器比坐标精准）。' +
    'action=screenshot 截屏（返回图像，图像坐标与点击坐标 1:1 对应 —— 这是"看屏幕再操作"的主循环）；' +
    'screen_info 列显示器（多屏坐标）；position 读指针位置；windows 列窗口；' +
    'open 打开/前置应用（app=应用名，如 "微信"/"Finder"，这是响应"帮我打开 X"的首选动作）；' +
    'click/drag/scroll/move 操作指针；type 输入文本（支持中文）；key 按键（key 名 + modifiers 修饰键）；' +
    'window_focus/window_move/window_resize 聚焦/移动/缩放窗口（app + index 或 title 定位）。' +
    '坐标系：macOS 全局逻辑坐标，主屏左上角 (0,0)，副屏可为负坐标。' +
    '写动作默认需要用户确认；首次使用需在系统设置里授予「辅助功能」（合成事件/读窗口）与「屏幕录制」（截屏）权限。',
  parameters: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: COMPUTER_ACTIONS, description: '要做的动作' },
      x: { type: 'number', description: 'click / move 的横坐标（全局逻辑坐标）' },
      y: { type: 'number', description: 'click / move 的纵坐标' },
      button: { type: 'string', enum: ['left', 'right', 'middle'], description: 'click 用的鼠标键（默认 left）' },
      clickCount: { type: 'number', description: 'click 连击次数：1 单击、2 双击（默认 1）' },
      fromX: { type: 'number', description: 'drag 起点 x' },
      fromY: { type: 'number', description: 'drag 起点 y' },
      toX: { type: 'number', description: 'drag 终点 x' },
      toY: { type: 'number', description: 'drag 终点 y' },
      direction: { type: 'string', enum: ['up', 'down', 'left', 'right'], description: 'scroll 方向' },
      amount: { type: 'number', description: 'scroll 滚动量（行，默认 5）' },
      text: { type: 'string', description: 'type 要输入的文本（支持中文）' },
      key: { type: 'string', description: 'key 的键名：Enter/Tab/Escape/ arrows(up down left right)/a-z/0-9/f1-f12 等' },
      modifiers: { type: 'array', items: { type: 'string' }, description: 'key 的修饰键：cmd / ctrl / option / shift / fn，如 ["cmd","shift"]' },
      screen: { type: 'number', description: 'screenshot 截哪块屏（0=主屏，默认 0；块数见 screen_info）' },
      app: { type: 'string', description: 'open 要打开的应用名（如 "微信"）；windows 按应用名过滤；window_* 必填，应用名要与 windows 列表一致' },
      title: { type: 'string', description: 'windows / window_* 按窗口标题过滤（包含匹配）' },
      index: { type: 'number', description: 'window_* 目标窗口序号（1 起，默认 1；序号见 windows 列表）' }
    },
    required: ['action']
  },

  async execute(args, ctx = {}) {
    if (process.platform !== 'darwin') {
      return 'Computer 工具目前只支持 macOS（依赖 osascript/CoreGraphics/screencapture）。';
    }

    const action = String(args?.action ?? '').trim();
    if (!COMPUTER_ACTIONS.includes(action)) {
      return `未知的 action：${action || '(空)'}。可用：${COMPUTER_ACTIONS.join(' / ')}`;
    }

    const timeoutMs = clampInt(ctx.cfg?.computerTimeout, 1000, 120000, DEFAULT_TIMEOUT_MS);

    try {
      // ---- 看类动作 ----
      if (action === 'screenshot') {
        const screenIdx = clampInt(args.screen, 0, 9, 0);
        const r = await takeScreenshot(screenIdx);
        return {
          text: `已截取屏幕 ${screenIdx}（${r.w}×${r.h} 逻辑像素${r.scale > 1 ? `，Retina ${r.scale}x 已缩回` : ''}）。\n\n图像坐标与 click/move 的坐标 1:1 对应 —— 从图里确定目标位置后直接给坐标即可。`,
          image: { media_type: 'image/png', data_url: r.data_url }
        };
      }
      if (action === 'position') {
        const out = await jxa(jxaPosition(), 8000);
        return present(action, JSON.parse(out || '{"x":0,"y":0}'));
      }
      if (action === 'screen_info') {
        const screens = JSON.parse(await jxa(jxaScreens(), 8000));
        return present(action, { screens });
      }
      if (action === 'windows') {
        let list = await listWindows(timeoutMs);
        const app = String(args.app ?? '').trim();
        const title = String(args.title ?? '').trim();
        if (app) list = list.filter((w) => w.app.toLowerCase().includes(app.toLowerCase()));
        if (title) list = list.filter((w) => (w.title || '').toLowerCase().includes(title.toLowerCase()));
        const limit = clampInt(args.limit, 1, 200, 40);
        if (list.length > limit) list = list.slice(0, limit);
        return present(action, { list });
      }

      // ---- open：open -a 不依赖辅助功能权限，放在权限探测之前 ----
      if (action === 'open') {
        const app = String(args.app ?? '').trim();
        if (!app) return 'open 需要 app 参数（应用名，如 "微信"、"Finder"、"Safari"；运行中的应用名可先 action="windows" 查）。';
        const r = await spawnCmd('open', ['-a', app], { timeout: 10000 });
        if (!r.ok) {
          const why = cleanOsaErr(r.stderr, r);
          return `打开应用「${app}」失败：${why === '未知错误' ? '找不到这个应用' : why}。` +
            '应用名要与系统里的一致（可先 action="windows" 看运行中的应用；未安装的应用请直接告知用户）。';
        }
        return present(action, { app });
      }

      // ---- 写类动作：先确认辅助功能在位（CGEventPost 缺权限会静默丢事件）----
      if (!(await hasAccessibility())) {
        return cleanOsaErr('osascript is not allowed assistive access. (-25211)');
      }

      if (action === 'click') {
        const nx = needNum(args.x, 'x');
        if (nx.err) return nx.err;
        const ny = needNum(args.y, 'y');
        if (ny.err) return ny.err;
        const m = MOUSE[String(args.button ?? 'left').toLowerCase()] || MOUSE.left;
        const n = clampInt(args.clickCount, 1, 3, 1);
        await jxa(jxaClick(Math.round(nx.n), Math.round(ny.n), m, n), timeoutMs);
        return present(action, { x: Math.round(nx.n), y: Math.round(ny.n), button: String(args.button ?? 'left').toLowerCase(), clickCount: n });
      }
      if (action === 'move') {
        const nx = needNum(args.x, 'x');
        if (nx.err) return nx.err;
        const ny = needNum(args.y, 'y');
        if (ny.err) return ny.err;
        await jxa(jxaMove(Math.round(nx.n), Math.round(ny.n)), timeoutMs);
        return present(action, { x: Math.round(nx.n), y: Math.round(ny.n) });
      }
      if (action === 'drag') {
        const pts = {};
        for (const k of ['fromX', 'fromY', 'toX', 'toY']) {
          const r = needNum(args[k], k);
          if (r.err) return `drag 需要 ${k} 参数。${r.err}`;
          pts[k] = Math.round(r.n);
        }
        const m = MOUSE[String(args.button ?? 'left').toLowerCase()] || MOUSE.left;
        await jxa(jxaDrag(pts.fromX, pts.fromY, pts.toX, pts.toY, m), timeoutMs);
        return present(action, pts);
      }
      if (action === 'scroll') {
        const amount = clampInt(args.amount, 1, 200, 5);
        const dir = String(args.direction ?? 'down').toLowerCase();
        const sign = { down: -1, up: 1 }[dir];
        if (sign != null) await jxa(jxaScroll(sign * amount, 0), timeoutMs);
        else if (dir === 'left') await jxa(jxaScroll(0, -amount), timeoutMs);
        else if (dir === 'right') await jxa(jxaScroll(0, amount), timeoutMs);
        else return `scroll 的 direction 只能是 up/down/left/right：${args.direction}`;
        return present(action, { direction: dir, amount });
      }
      if (action === 'type') {
        const text = String(args.text ?? '');
        if (!text) return 'type 需要 text 参数。';
        if (text.length > MAX_TYPE_CHARS) return `type 单次最多 ${MAX_TYPE_CHARS} 字符（当前 ${text.length}）—— 分段输入。`;
        await jxa(jxaType(text), timeoutMs);
        return present(action, { len: text.length });
      }
      if (action === 'key') {
        const script = asKeyScript(args.key, args.modifiers);
        if (!script) {
          return `不认识的键名：${JSON.stringify(args.key)}。可以用：Enter/Tab/Escape/Space/Delete/方向键/Home/End/PageUp/PageDown/F1-F12/a-z/0-9，或单个符号（如 ! ? :）。要输入整段文字请用 action="type"。`;
        }
        const r = await osa(script, { timeout: timeoutMs });
        if (!r.ok) throw new Error(cleanOsaErr(r.stderr, r));
        const label = [...(Array.isArray(args.modifiers) ? args.modifiers : []), args.key].filter(Boolean).join('+');
        return present(action, { label });
      }
      if (action === 'window_focus' || action === 'window_move' || action === 'window_resize') {
        const app = String(args.app ?? '').trim();
        if (!app) return `${action} 需要 app 参数（应用名，先用 action="windows" 看列表）。`;
        if (action === 'window_move' || action === 'window_resize') {
          const na = needNum(args.x ?? args.w, action === 'window_move' ? 'x' : 'w');
          if (na.err) return `${action} 需要${action === 'window_move' ? ' x 和 y' : ' w 和 h'} 参数。`;
          const nb = needNum(args.y ?? args.h, action === 'window_move' ? 'y' : 'h');
          if (nb.err) return `${action} 需要${action === 'window_move' ? ' x 和 y' : ' w 和 h'} 参数。`;
          const script = asWindowOpScript(app, args.index, args.title, action === 'window_move' ? 'move' : 'size', Math.round(na.n), Math.round(nb.n));
          const r = await osa(script, { timeout: timeoutMs });
          if (!r.ok) throw new Error(cleanOsaErr(r.stderr, r));
          return present(action, action === 'window_move'
            ? { app, x: Math.round(na.n), y: Math.round(nb.n) }
            : { app, w: Math.round(na.n), h: Math.round(nb.n) });
        }
        const script = asWindowOpScript(app, args.index, args.title, 'focus');
        const r = await osa(script, { timeout: timeoutMs });
        if (!r.ok) throw new Error(cleanOsaErr(r.stderr, r));
        return present(action, { app, index: clampInt(args.index, 1, 100, 1), title: String(args.title ?? '').trim() });
      }

      return `未实现的 action：${action}`;
    } catch (e) {
      const msg = e?.message || String(e);
      const hint = action === 'windows' || action.startsWith('window_')
        ? WINDOW_HINT
        : action === 'click' || action === 'move' || action === 'drag'
          ? '坐标可能不在可视区域内 —— 先 action="screenshot" 确认目标位置。'
          : '';
      return `Computer 操作失败（${action}）：${msg}${hint ? `\n${hint}` : ''}`;
    }
  }
};

export const computerTools = [computerTool];
