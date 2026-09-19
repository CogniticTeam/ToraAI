/**
 * 登录/注册动效套件（CoCode 自有品牌风，纯 CSS + SVG，零外部资源）：
 *   · BrandLogo    —— CoCode 品牌标（logo.PNG 圆角图标，login/gate/账号页共用）
 *   · AuthBackdrop —— 极光背景：两团缓漂的渐变光斑 + 细网格（铺在表单底下）
 *   · LogoLoader   —— 启动校验：logo 呼吸 + 细环形旋转
 *   · SuccessCheck —— 登录成功：圆圈 + 对勾 stroke 描边
 *   · DotPulse     —— 单色三点跳动（提交按钮 busy 态）
 * keyframes 统一在 index.css。
 */

export function BrandLogo({ size = 48 }: { size?: number }) {
	// 品牌标：logo.PNG 生成的圆角图标（白底黑色 ‹_ 终端字形，四角透明）。
	// 圆角已烘焙进图片本身，无需再设 borderRadius。
	return (
		<img
			src="/icon.png"
			alt="CoCode"
			width={size}
			height={size}
			className="brand-breathe shadow-lg"
			draggable={false}
		/>
	);
}

/** 极光背景：absolute 铺满，表单内容应叠在其上（z-10） */
export function AuthBackdrop() {
	return (
		<div className="pointer-events-none absolute inset-0 overflow-hidden" aria-hidden>
			<div className="auth-aurora auth-aurora-a" />
			<div className="auth-aurora auth-aurora-b" />
			{/* 细网格：低调衬底 */}
			<div className="auth-grid absolute inset-0" />
		</div>
	);
}

/** 启动校验：logo 呼吸 + 环形旋转 */
export function LogoLoader() {
	return (
		<div className="relative flex items-center justify-center">
			{/* 环形 spinner：底环 + 旋转亮弧 */}
			<span className="absolute size-20 rounded-full border-2 border-border" />
			<span className="ring-spin absolute size-20 rounded-full border-2 border-transparent border-t-primary" />
			<BrandLogo size={52} />
		</div>
	);
}

/** 登录成功：圆圈 + 对勾 stroke 描边（0.8s 内完成） */
export function SuccessCheck({ size = 72 }: { size?: number }) {
	return (
		<svg viewBox="0 0 52 52" style={{ width: size, height: size }} fill="none">
			<circle
				cx="26"
				cy="26"
				r="24"
				stroke="currentColor"
				strokeWidth="2"
				className="check-circle text-primary"
			/>
			<path
				d="M15 27l8 8 15-16"
				stroke="currentColor"
				strokeWidth="3"
				strokeLinecap="round"
				strokeLinejoin="round"
				className="check-mark text-primary"
			/>
		</svg>
	);
}

/** 提交按钮 busy 态：单色三点跳动 */
export function DotPulse({ className = '' }: { className?: string }) {
	return (
		<span className={`inline-flex items-center gap-[4px] ${className}`} role="status" aria-label="loading">
			{[0, 1, 2].map((i) => (
				<span
					key={i}
					className="size-[5px] rounded-full bg-current"
					style={{ animation: `dot-pulse 1s ease-in-out ${i * 0.15}s infinite` }}
				/>
			))}
		</span>
	);
}
