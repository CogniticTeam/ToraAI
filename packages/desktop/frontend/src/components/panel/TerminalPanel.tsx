// 内置终端面板。
//
// 后端（core asapi /terminal/*）用 child_process.spawn($SHELL -i) 提供持久
// shell —— 没有 PTY（node-pty 需要原生编译链，会破坏 core 的零依赖策略），
// TERM=dumb 下 shell 走逐行回显模式：看输出、敲命令、跑构建都可用，
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
	 * 工作目录：shell 从这里起。`null` 时（会话未就绪 / 还没选目录）
	 * 面板显示引导文案，不建终端。
	 */
	cwd: string | null;
}

type Phase = 'connecting' | 'running' | 'exited' | 'error';

export function TerminalPanel({ cwd }: TerminalPanelProps) {
	const { i18n } = useTranslation();
	const zh = i18n.language.startsWith('zh');
	const hostRef = useRef<HTMLDivElement | null>(null);
	const sessionIdRef = useRef<string | null>(null);
	const [phase, setPhase] = useState<Phase>('connecting');
	const [errorMsg, setErrorMsg] = useState<string | null>(null);
	// 自增触发重建：重连按钮只动它，effect 以它为依赖整体重来。
	const [attempt, setAttempt] = useState(0);

	useEffect(() => {
		if (!cwd) return;
		const host = hostRef.current;
		if (!host) return;

		const term = new Terminal({
			convertEol: true,
			cursorBlink: true,
			fontSize: 12,
			fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
			// 透明背景 + 跟随宿主前景色：亮/暗主题下都不突兀
			allowTransparency: true,
			theme: {
				background: 'rgba(0,0,0,0)',
				foreground: getComputedStyle(host).color,
			},
		});
		const fit = new FitAddon();
		term.loadAddon(fit);
		term.open(host);
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
		setPhase('connecting');
		setErrorMsg(null);

		void (async () => {
			try {
				const session = await terminalApi.create(cwd);
				if (disposed) {
					// 竞态兜底：卸载发生在 create 返回之后，也不能留下孤儿 shell
					void terminalApi.kill(session.id).catch(() => {});
					return;
				}
				sessionIdRef.current = session.id;
				// 键入上行：xterm 本地不回显（后端 shell 会回显），回车以 \n 发出。
				term.onData((data) => {
					void terminalApi.write(session.id, data).catch(() => {});
				});
				setPhase('running');
				for await (const ev of terminalApi.stream(session.id, ac.signal)) {
					if (ev.type === 'data') term.write(ev.data);
					else if (ev.type === 'replay') term.write(ev.data);
					else if (ev.type === 'exit') {
						setPhase('exited');
						return;
					}
				}
				// 流在没有 exit 帧的情况下结束 = 连接断了（服务器重启 / 网络断）。
				if (!disposed && !ac.signal.aborted) {
					setPhase('error');
					setErrorMsg(zh ? '连接已断开' : 'Connection lost');
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
			// 面板关闭就收掉 shell：后端只有 8 个槽位，不留无主进程。
			const id = sessionIdRef.current;
			if (id) {
				sessionIdRef.current = null;
				void terminalApi.kill(id).catch(() => {});
			}
			term.dispose();
		};
	}, [cwd, attempt]);

	if (!cwd) {
		return (
			<div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 pb-2 text-center text-[11px] text-muted-foreground">
				<SquareTerminal className="size-5" />
				{zh ? '先选择工作目录，再打开终端。' : 'Select a workspace before opening the terminal.'}
			</div>
		);
	}

	return (
		<div className="flex min-h-0 flex-1 flex-col gap-2 pb-2">
			{phase === 'exited' || phase === 'error' ? (
				<div className="flex items-start gap-x-1.5 rounded-md border border-destructive bg-destructive-soft px-2 py-1.5 text-[11px] text-destructive">
					<TriangleAlert className="mt-0.5 size-3 shrink-0" />
					<span className="min-w-0 flex-1 break-words">
						{phase === 'exited' ? (zh ? '终端已退出。' : 'Terminal exited.') : `${zh ? '连接失败' : 'Connection failed'}: ${errorMsg ?? (zh ? '未知错误' : 'Unknown error')}`}
					</span>
					<Button
						variant="ghost"
						size="icon-sm"
						aria-label={zh ? '重新打开终端' : 'Reopen terminal'}
						onClick={() => setAttempt((n) => n + 1)}
					>
						<RotateCw className="size-3.5" />
					</Button>
				</div>
			) : null}
			<div
				ref={hostRef}
				className={cn(
					'min-h-0 flex-1 overflow-hidden rounded-md border border-border bg-background p-1',
					phase === 'connecting' && 'opacity-60',
				)}
			/>
		</div>
	);
}
