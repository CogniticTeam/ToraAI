import { Trophy } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';

import { getBaseUrl, getUserId } from '@/api/client';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { useTranslation } from '@/i18n/useI18n';

type MilestoneStatus = { totalTokens: number; pending: number[] };

const LEVEL_KEYS: Record<number, string> = {
	100_000: '100k',
	1_000_000: '1m',
	10_000_000: '10m',
	100_000_000: '100m',
	500_000_000: '500m',
	1_000_000_000: '1b',
	2_000_000_000: '2b',
	5_000_000_000: '5b',
	10_000_000_000: '10b',
};

const endpoint = (path: string) => new URL(path, getBaseUrl() || window.location.href).toString();
const headers = () => ({ 'X-User-ID': getUserId() });

/** 全局累计 Token 里程碑：后端持久化待展示队列，用户关闭弹窗后才确认。 */
export function TokenMilestoneDialog() {
	const { t, i18n } = useTranslation();
	const [status, setStatus] = useState<MilestoneStatus | null>(null);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState('');
	const busyRef = useRef(false);
	const requestSeqRef = useRef(0);

	const refresh = useCallback(async () => {
		if (busyRef.current) return;
		const requestSeq = ++requestSeqRef.current;
		try {
			const response = await fetch(endpoint('/admin/usage-milestones'), { headers: headers() });
			if (!response.ok) return;
			const data = await response.json() as MilestoneStatus;
			if (requestSeq === requestSeqRef.current && !busyRef.current &&
				Number.isFinite(data.totalTokens) && Array.isArray(data.pending)) {
				setStatus({ totalTokens: data.totalTokens, pending: data.pending.filter((value) => LEVEL_KEYS[value]) });
			}
		} catch { /* 离线时等待下次轮询，不能干扰聊天 */ }
	}, []);

	useEffect(() => {
		void refresh();
		const timer = window.setInterval(() => void refresh(), 5_000);
		window.addEventListener('focus', refresh);
		return () => { window.clearInterval(timer); window.removeEventListener('focus', refresh); };
	}, [refresh]);

	const milestone = status?.pending[0] ?? null;
	const acknowledge = async () => {
		if (milestone === null || busyRef.current) return;
		busyRef.current = true;
		requestSeqRef.current++;
		setBusy(true);
		setError('');
		try {
			const response = await fetch(endpoint(`/admin/usage-milestones/${milestone}/ack`), {
				method: 'POST', headers: headers(),
			});
			if (!response.ok) throw new Error(`HTTP ${response.status}`);
			setStatus(await response.json() as MilestoneStatus);
		} catch {
			setError(t('usageMilestone.retry'));
		} finally {
			busyRef.current = false;
			setBusy(false);
		}
	};

	const levelKey = milestone === null ? null : LEVEL_KEYS[milestone];
	const level = levelKey ? t(`usageMilestone.levels.${levelKey}`) : '';
	const total = new Intl.NumberFormat(i18n.language).format(status?.totalTokens ?? 0);
	return (
		<Dialog open={milestone !== null} onOpenChange={(open) => { if (!open) void acknowledge(); }}>
			<DialogContent showCloseButton={false} className="overflow-hidden p-0 sm:max-w-[26rem]">
				<div className="relative overflow-hidden bg-gradient-to-br from-amber-50 via-background to-orange-100 px-7 pb-7 pt-9 text-center dark:from-amber-950/40 dark:via-background dark:to-orange-900/20">
					<div aria-hidden="true" className="absolute -right-10 -top-12 size-36 rounded-full border border-amber-500/15" />
					<div aria-hidden="true" className="absolute -bottom-20 -left-10 size-40 rounded-full border border-amber-500/15" />
					<div className="relative mx-auto mb-5 grid size-16 place-items-center rounded-2xl bg-amber-500/15 text-amber-600 dark:text-amber-400">
						<Trophy className="size-8" strokeWidth={1.7} />
					</div>
					<DialogTitle className="text-sm font-semibold tracking-wide text-amber-700 dark:text-amber-300">{t('usageMilestone.title')}</DialogTitle>
					<div className="mt-3 text-5xl font-semibold tracking-tight text-foreground tabular-nums">{level}</div>
					<DialogDescription className="mt-2 text-sm text-muted-foreground">{t('usageMilestone.subtitle')}</DialogDescription>
				</div>
				<div className="space-y-4 px-7 pb-7 pt-5 text-center">
					<p className="text-sm text-muted-foreground">{t('usageMilestone.total', { count: total })}</p>
					{status && status.pending.length > 1 ? (
						<p className="text-xs text-muted-foreground">{t('usageMilestone.more', { count: status.pending.length - 1 })}</p>
					) : null}
					{error ? <p role="alert" className="text-xs text-destructive">{error}</p> : null}
					<Button className="w-full" disabled={busy} onClick={() => void acknowledge()}>{t('usageMilestone.continue')}</Button>
				</div>
			</DialogContent>
		</Dialog>
	);
}
