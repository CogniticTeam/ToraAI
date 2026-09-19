/**
 * 订阅独立弹窗（从侧边栏入口打开，不嵌在设置窗口里）。
 * 复用 SettingsDialog 的浮层+居中卡片动画模式，内容由 SubscriptionSection 承载。
 */
import { X } from 'lucide-react';
import { useEffect, useState } from 'react';

import { SubscriptionSection } from '@/components/dialog/SubscriptionSection';
import { useTranslation } from '@/i18n/useI18n';

interface Props {
	open: boolean;
	onOpenChange: (open: boolean) => void;
}

export function SubscriptionDialog({ open, onOpenChange }: Props) {
	const { t } = useTranslation();

	// 与 SettingsDialog 一致：open→false 时延迟 200ms 卸载，播完退出动画
	const [mounted, setMounted] = useState(open);
	useEffect(() => {
		if (open) {
			setMounted(true);
			return;
		}
		const timer = setTimeout(() => setMounted(false), 200);
		return () => clearTimeout(timer);
	}, [open]);

	if (!mounted) return null;

	const closing = mounted && !open;

	return (
		<div
			aria-hidden={closing}
			className={
				'fixed inset-0 z-50 flex items-center justify-center bg-scrim ' +
				(closing ? 'animate-out fade-out-0 duration-200' : 'animate-in fade-in-0 duration-200')
			}
			onClick={() => onOpenChange(false)}
		>
			<div
				className={
					'relative flex max-h-[88vh] w-[760px] max-w-[92vw] flex-col overflow-hidden rounded-2xl border border-border bg-background text-card-foreground shadow-2xl ease-out ' +
					(closing
						? 'animate-out fade-out-0 zoom-out-95 slide-out-to-bottom-3 duration-200'
						: 'animate-in fade-in-0 zoom-in-95 slide-in-from-bottom-3 duration-250')
				}
				onClick={(e) => e.stopPropagation()}
			>
				{/* 顶栏：标题 + 关闭 */}
				<div className="flex items-center justify-between border-b border-border px-6 py-4">
					<h3 className="text-base font-semibold">{t('subscription.title')}</h3>
					<button
						type="button"
						aria-label={t('settings.close')}
						className="rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
						onClick={() => onOpenChange(false)}
					>
						<X className="size-4" />
					</button>
				</div>

				{/* 内容滚动区 */}
				<div className="min-h-0 flex-1 overflow-y-auto px-8 py-5">
					<SubscriptionSection onClose={() => onOpenChange(false)} />
				</div>
			</div>
		</div>
	);
}
