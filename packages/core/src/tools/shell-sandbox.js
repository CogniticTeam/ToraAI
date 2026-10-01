// Bash 工具的进程级边界。文件工具的路径检查拦不住 shell 内的重定向、
// 子进程和脚本；因此默认权限模式用系统沙箱限制写入根，显式 bypass 才不套。
import { accessSync, constants, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { realpathAllowMissing } from '../security.js';

const quote = (value) => JSON.stringify(value);

export function sandboxOptionsForContext(ctx) {
  return {
    enabled: !!ctx?.permissionMode && ctx.permissionMode !== 'bypass' && ctx.shellSandbox !== false,
    roots: ctx?.sandboxRoots,
    networkAccess: ctx?.shellNetworkAccess === true
  };
}

export function shellSandboxKey(cwd, sandbox = {}) {
  if (!sandbox.enabled) return `${cwd}\0unrestricted`;
  const roots = [...new Set((sandbox.roots?.length ? sandbox.roots : [cwd]).map(realpathAllowMissing))].sort();
  return `${cwd}\0sandbox\0${sandbox.networkAccess !== false}\0${roots.join('\0')}`;
}

export function macosShellProfile({ roots, scratch, networkAccess = true, cwd }) {
  const writable = [...new Set([...roots, scratch].map(realpathAllowMissing))];
  return [
    '(version 1)', '(deny default)',
    '(allow process-exec)', '(allow process-fork)',
    '(allow signal (target same-sandbox))',
    '(allow process-info* (target same-sandbox))',
    '(allow file-read*)',
    '(allow file-write-data (path "/dev/null"))',
    '(allow mach-lookup)', '(allow mach-host*)',
    '(allow sysctl-read)', '(allow iokit-open)',
    ...(networkAccess ? ['(allow network*)'] : []),
    ...writable.map((root) => `(allow file-write* (subpath ${quote(root)}))`),
    // 工作树元数据和项目本地配置只有专用 Git/设置路径可以更改。
    ...['.git', '.tora'].flatMap((name) => {
      const target = join(realpathAllowMissing(cwd), name);
      return [`(deny file-write* (literal ${quote(target)}))`, `(deny file-write* (subpath ${quote(target)}))`];
    })
  ].join('\n');
}

function linuxBubblewrap() {
  for (const candidate of ['/usr/bin/bwrap', '/bin/bwrap', '/usr/local/bin/bwrap']) {
    try { accessSync(candidate, constants.X_OK); return candidate; } catch { /* try next */ }
  }
  return null;
}

/** 返回 shell 的启动包装及临时目录；不可执行沙箱时抛错，绝不静默降级。 */
export function prepareShellSandbox(cwd, sandbox = {}) {
  if (!sandbox.enabled) return { executable: null, args: [], env: {}, cleanup: () => {} };
  const scratch = realpathAllowMissing(mkdtempSync(join(tmpdir(), 'tora-shell-')));
  const roots = [...new Set((sandbox.roots?.length ? sandbox.roots : [cwd]).map(realpathAllowMissing))];
  const cleanup = () => rmSync(scratch, { recursive: true, force: true });
  const env = {
    TMPDIR: scratch,
    TMP: scratch,
    npm_config_cache: join(scratch, 'npm-cache'),
    PIP_CACHE_DIR: join(scratch, 'pip-cache'),
    XDG_CACHE_HOME: join(scratch, 'cache')
  };
  try {
    if (process.platform === 'darwin') {
      if (!existsSync('/usr/bin/sandbox-exec')) throw new Error('macOS Seatbelt 不可用');
      return {
        executable: '/usr/bin/sandbox-exec',
        args: ['-p', macosShellProfile({ roots, scratch, networkAccess: sandbox.networkAccess !== false, cwd })],
        env, cleanup
      };
    }
    if (process.platform === 'linux') {
      const executable = linuxBubblewrap();
      if (!executable) throw new Error('缺少 bwrap，无法隔离 Bash 子进程');
      const args = ['--die-with-parent', '--ro-bind', '/', '/', '--dev-bind', '/dev', '/dev', '--proc', '/proc',
        ...roots.flatMap((root) => ['--bind', root, root]), '--bind', scratch, scratch, '--chdir', cwd];
      if (sandbox.networkAccess === false) args.push('--unshare-net');
      for (const name of ['.git', '.tora']) {
        const target = join(realpathAllowMissing(cwd), name);
        if (existsSync(target)) args.push('--ro-bind', target, target);
      }
      return { executable, args: [...args, '--'], env, cleanup };
    }
    throw new Error(`当前平台 ${process.platform} 尚无 Bash 进程沙箱；请在确认风险后使用 bypass 模式`);
  } catch (error) {
    cleanup();
    throw error;
  }
}
