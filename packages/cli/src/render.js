// CLI 事件渲染器：Agent 事件流 → 终端 ANSI 输出（REPL 与一次性任务共用）
const C = {
  reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m',
  red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m',
  blue: '\x1b[34m', magenta: '\x1b[35m', cyan: '\x1b[36m'
};

function previewArgs(args) {
  const s = JSON.stringify(args) || '';
  return s.length > 100 ? s.slice(0, 100) + '…' : s;
}

function firstLine(text, max = 110) {
  const l = (text || '').split('\n').find((x) => x.trim()) || '';
  return l.length > max ? l.slice(0, max) + '…' : l;
}

/**
 * @returns {{feed(ev:Object):void}} 消费 runAgent 事件并渲染
 */
export function createAgentRenderer() {
  let inText = false;
  let chars = 0;
  return {
    feed(ev) {
      switch (ev.type) {
        case 'text-delta':
          process.stdout.write(ev.text);
          inText = true; chars += ev.text.length;
          break;
        case 'tool-start': {
          if (inText) process.stdout.write('\n\n');
          inText = false;
          console.log(`${C.cyan}⚙ ${ev.name}${C.reset} ${C.dim}${previewArgs(ev.args)}${C.reset}`);
          break;
        }
        case 'tool-result': {
          const dur = ev.durationMs > 1000 ? (ev.durationMs / 1000).toFixed(1) + 's' : ev.durationMs + 'ms';
          console.log(`${C.dim}  ↳ ${firstLine(ev.result)} ${C.reset}${C.dim}(${dur})${C.reset}`);
          break;
        }
        case 'require-confirm':
          // 交互确认由调用方（repl.js 的 permissionAsk）负责问答，这里只提示
          console.log(`${C.yellow}⚠ 权限确认${C.reset} ${C.bold}${ev.name}${C.reset} ${C.dim}${previewArgs(ev.args)}${C.reset}`);
          break;
        case 'confirm-resolved':
          console.log(`${C.dim}  ↳ 用户${ev.confirmed ? '允许' : '拒绝'}${C.reset}`);
          break;
        case 'checkpoint':
          console.log(`${C.dim}[检查点] 第 ${ev.turn} 轮已快照 ${ev.fileCount} 个文件（可回滚）${C.reset}`);
          break;
        case 'mode-changed':
          console.log(`${C.yellow}[能力降级] ${ev.reason}${C.reset}`);
          break;
        case 'compact':
          console.log(`${C.yellow}[上下文治理] 驱逐旧工具输出 ${ev.evicted} 条${ev.compacted ? '，已摘要压缩历史' : ''}${C.reset}`);
          break;
        case 'hook': {
          if (!ev.ran && !(ev.errors || []).length) break;
          const d = ev.decision ? ` → ${ev.decision}${ev.reason ? '（' + ev.reason + '）' : ''}` : '';
          const where = ev.tool ? ` [${ev.tool}]` : '';
          console.log(`${C.magenta}[钩子] ${ev.event}${where} 跑了 ${ev.ran} 个${d}${C.reset}`);
          for (const n of ev.notices || []) console.log(`${C.dim}  ⚠ ${n}${C.reset}`);
          for (const er of ev.errors || []) console.log(`${C.red}  ✗ ${er}${C.reset}`);
          if (ev.context) console.log(`${C.dim}  ${ev.context}${C.reset}`);
          break;
        }
        case 'turn-end':
          break;
        case 'done': {
          if (inText) process.stdout.write('\n\n');
          const u = ev.totalUsage || {};
          const cached = u.cached_tokens ? `, cached ${u.cached_tokens}` : '';
          const tok = u.prompt_tokens ? `${C.dim}prompt ${u.prompt_tokens} + completion ${u.completion_tokens || 0} tokens${cached}${C.reset}` : '';
          const mark = ev.reason === 'completed' ? `${C.green}✓ 完成${C.reset}`
            : ev.reason === 'aborted' ? `${C.yellow}⏹ 已中止${C.reset}`
            : ev.reason === 'blocked' ? `${C.magenta}⛔ 被钩子拦下${C.reset}`
            : `${C.yellow}⚠ ${ev.reason}${C.reset}`;
          console.log(`${mark}${tok ? '  ' + tok : ''}\n`);
          if (ev.reason === 'blocked' && ev.message) console.log(`${C.dim}${ev.message}${C.reset}\n`);
          break;
        }
        case 'error':
          console.log(`\n${C.red}✗ ${ev.error}${C.reset}\n`);
          break;
      }
    }
  };
}

export { C };
