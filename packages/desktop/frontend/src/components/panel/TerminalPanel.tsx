// 内置终端面板。
//
// 后端（core asapi /terminal/*）用 child_process.spawn($SHELL -i) 提供持久
// shell —— 没有 PTY（node-pty 需要原生编译链，会破坏 core 的零依赖策略），
// TERM=dumb 下前端负责逐行编辑/回显：看输出、敲命令、跑构建都可用，
// vim/htop 这类全屏 TUI 不承诺。下行输出走 SSE（replay 回放 + data 实时），
// 上行键入走 POST write —— 全栈无 WebSocket。
//
// 生命周期：面板挂载即 create + stream，卸载即 kill（后端只有 8 个槽位，
// 不留无主 shell）。cwd 变化或点重连按钮都整体重建。

import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import { RotateCw, SquareTerminal, TriangleAlert } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

import { terminalApi } from '@/api/terminal';
import { Button } from '@/components/ui/button';
import { useTranslation } from '@/i18n/useI18n';
import { cn } from '@/lib/utils';

interface TerminalPanelProps {
	/**
	 * 工作目录：shell 从这里起。`null` 时由后端从用户主目录启动。
	 */
	cwd: string | null;
}

type Phase = 'connecting' | 'running' | 'exited' | 'error';

export function TerminalPanel({ cwd }: TerminalPanelProps) {
	const { i18n } = useTranslation();
	const zh = i18n.language.startsWith('zh');
	const languageRef = useRef(zh);
	useEffect(() => { languageRef.current = zh; }, [zh]);
	const hostRef = useRef<HTMLDivElement | null>(null);
	const sessionIdRef = useRef<string | null>(null);
	const [phase, setPhase] = useState<Phase>('connecting');
	const [errorMsg, setErrorMsg] = useState<string | null>(null);
	const [activeDir, setActiveDir] = useState<string | null>(null);
	// 自增触发重建：重连按钮只动它，effect 以它为依赖整体重来。
	const [attempt, setAttempt] = useState(0);

	useEffect(() => {
		const host = hostRef.current;
		if (!host) return;
		const themeForHost = () => {
			const style = getComputedStyle(host);
			return {
				background: style.backgroundColor,
				foreground: style.color,
				cursor: style.color,
				cursorAccent: style.backgroundColor,
			};
		};

		const term = new Terminal({
			convertEol: true,
			cursorBlink: true,
			fontSize: 12,
			fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
			// xterm 的透明 Canvas 在浅色主题实际会落成黑底；显式指定不透明
			// 背景和对应文字色，避免命令输出几乎不可见。
			theme: themeForHost(),
		});
		const fit = new FitAddon();
		term.loadAddon(fit);
		term.open(host);
		const updateTheme = () => { term.options.theme = themeForHost(); };
		const themeObserver = new MutationObserver(updateTheme);
		themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'data-theme', 'style'] });
		themeObserver.observe(document.body, { attributes: true, attributeFilter: ['class', 'data-theme', 'style'] });
		const colorScheme = window.matchMedia('(prefers-color-scheme: dark)');
		colorScheme.addEventListener('change', updateTheme);
		try {
			fit.fit();
		} catch {
			// 面板刚插入布局时尺寸可能是 0；ResizeObserver 里还会再 fit
		}

		// 尺寸自适应：拖拽分栏 / 折叠 / 窗口缩放都走这里。
		const ro = new ResizeObserver(() => {
			try {
				fit.fit();
			} catch {
				// 折叠到 0 尺寸时 fit 会抛，静默等下一次有效尺寸
			}
		});
		ro.observe(host);

		const ac = new AbortController();
		let disposed = false;
		let inputListener: { dispose: () => void } | null = null;
		setPhase('connecting');
		setErrorMsg(null);
		setActiveDir(null);

		void (async () => {
			try {
				const session = await terminalApi.create(cwd);
				if (disposed) {
					// 竞态兜底：卸载发生在 create 返回之后，也不能留下孤儿 shell
					void terminalApi.kill(session.id).catch(() => {});
					return;
				}
				sessionIdRef.current = session.id;
				setActiveDir(session.cwd);
				// 无 PTY 的 shell 不会回显键入；本地维护一行输入，Enter 才整行提交。
				// 保留历史/退格，避免每敲一个字就发一条 HTTP 请求并引入乱序。
				let line = '';
				const history: string[] = [];
				let historyIndex = 0;
				let writeQueue = Promise.resolve();
				let inputFailed = false;
				const queueWrite = (data: string) => {
					writeQueue = writeQueue.then(async () => {
						if (!disposed && !inputFailed) await terminalApi.write(session.id, data);
					}).catch((error: unknown) => {
						if (disposed) return;
						inputFailed = true;
						setPhase('error');
						setErrorMsg(error instanceof Error ? error.message : String(error));
					});
				};
				const eraseLast = () => {
					const glyphs = Array.from(line);
					const last = glyphs.pop();
					if (!last) return;
					line = glyphs.join('');
					const cells = /[\u2e80-\u9fff\uac00-\ud7af\u{1f300}-\u{1faff}]/u.test(last) ? 2 : 1;
					term.write('\b \b'.repeat(cells));
				};
				const replaceLine = (next: string) => {
					while (line) eraseLast();
					line = next;
					term.write(next);
				};
				inputListener = term.onData((data) => {
					if (disposed || inputFailed) return;
					if (data === '\x1b[A') {
						if (historyIndex > 0) replaceLine(history[--historyIndex]);
						return;
					}
					if (data === '\x1b[B') {
						if (historyIndex < history.length) replaceLine(history[++historyIndex] ?? '');
						return;
					}
					// 无 PTY，左右方向键和其他终端控制序列暂不模拟成普通文字。
					if (data.startsWith('\x1b')) return;
					for (const character of data.replace(/\r\n?/g, '\n')) {
						if (character === '\n') {
							term.write('\r\n');
							if (line.trim()) {
								history.push(line);
								if (history.length > 100) history.shift();
							}
							historyIndex = history.length;
							queueWrite(`${line}\n`);
							line = '';
						} else if (character === '\x7f' || character === '\b') {
							eraseLast();
						} else if (character === '\x03') {
							line = '';
							term.write('^C\r\n');
							void terminalApi.interrupt(session.id).catch((error: unknown) => {
								if (!disposed) term.write(`\r\n[${error instanceof Error ? error.message : String(error)}]\r\n`);
							});
						} else if (character === '\t') {
							line += '    ';
							term.write('    ');
						} else if (character >= ' ' && character !== '\x7f') {
							line += character;
							term.write(character);
						}
					}
				});
				setPhase('running');
				term.focus();
				for await (const ev of terminalApi.stream(session.id, ac.signal)) {
					if (ev.type === 'data') term.write(ev.data);
					else if (ev.type === 'replay') term.write(ev.data);
					else if (ev.type === 'exit') {
						setErrorMsg(ev.error ?? (ev.code && ev.code !== 0 ? `${languageRef.current ? '退出码' : 'Exit code'} ${ev.code}` : null));
						setPhase('exited');
						return;
					}
				}
				// 流在没有 exit 帧的情况下结束 = 连接断了（服务器重启 / 网络断）。
				if (!disposed && !ac.signal.aborted) {
					setPhase('error');
					setErrorMsg(languageRef.current ? '连接已断开' : 'Connection lost');
				}
			} catch (e) {
				if (disposed || ac.signal.aborted) return;
				setPhase('error');
				setErrorMsg(e instanceof Error ? e.message : String(e));
			}
		})();

		return () => {
			disposed = true;
			ac.abort();
			ro.disconnect();
			themeObserver.disconnect();
			colorScheme.removeEventListener('change', updateTheme);
			inputListener?.dispose();
			// 面板关闭就收掉 shell：后端只有 8 个槽位，不留无主进程。
			const id = sessionIdRef.current;
			if (id) {
				sessionIdRef.current = null;
				void terminalApi.kill(id).catch(() => {});
			}
			term.dispose();
		};
	}, [cwd, attempt]);

	return (
		<div className="flex min-h-0 flex-1 flex-col gap-2 pb-2">
			<div className="flex items-center gap-2 px-1 text-[11px] text-muted-foreground">
				<SquareTerminal className="size-3.5 shrink-0" />
				<span className="min-w-0 flex-1 truncate" title={activeDir ?? undefined}>{activeDir ?? (cwd || (zh ? '用户主目录' : 'Home directory'))}</span>
				<span>{phase === 'connecting' ? (zh ? '连接中' : 'Connecting') : phase === 'running' ? (zh ? '逐行命令' : 'Line mode') : ''}</span>
				<Button variant="ghost" size="icon-sm" aria-label={zh ? '重新打开终端' : 'Reopen terminal'} title={zh ? '重新打开终端' : 'Reopen terminal'} onClick={() => setAttempt((n) => n + 1)}>
					<RotateCw className="size-3.5" />
				</Button>
			</div>
			{phase === 'exited' || phase === 'error' ? (
				<div className="flex items-start gap-x-1.5 rounded-md border border-destructive bg-destructive-soft px-2 py-1.5 text-[11px] text-destructive">
					<TriangleAlert className="mt-0.5 size-3 shrink-0" />
					<span className="min-w-0 flex-1 break-words">
						{phase === 'exited' ? `${zh ? '终端已退出。' : 'Terminal exited.'}${errorMsg ? ` ${errorMsg}` : ''}` : `${zh ? '连接失败' : 'Connection failed'}: ${errorMsg ?? (zh ? '未知错误' : 'Unknown error')}`}
					</span>
				</div>
			) : null}
			<div
				ref={hostRef}
				className={cn(
					'cocode-terminal min-h-0 flex-1 overflow-hidden rounded-md border border-border bg-background text-foreground p-1',
					phase === 'connecting' && 'opacity-60',
				)}
			/>
		</div>
	);
}
