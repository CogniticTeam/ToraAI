/**
 * 设置窗口「账号」板块 & 启动登录门槛共用的登录/注册界面。
 * 登录/注册一体流：首页输入「用户名或邮箱」→ 服务端 /auth/check 分流——
 *   已注册 → 密码页登录；未注册 → 注册页（用户名 + 邮箱 + 密码 + 邮箱验证码）。
 * 一号一邮箱由服务端 UNIQUE 约束保证。CoCode 自有视觉：
 *   · 极光光斑缓漂背景 + 网格衬底（AuthBackdrop）
 *   · 居中玻璃卡片（spring 入场）
 *   · 步骤切换：AnimatePresence 滑动过渡（首页 → 密码 / 注册）
 *   · 提交 busy：DotPulse 三点；成功后 LoginGate 播放 SuccessCheck 描边
 *
 * 后端：Cloudflare Worker（packages/auth-worker，D1 存储 + Resend 发验证码）。
 * 服务地址存 localStorage('cocode_auth_api')，默认线上部署地址。
 */
import { AnimatePresence, motion } from 'framer-motion';
import { ArrowLeft, AtSign, Camera, ChevronDown, Eye, EyeOff, KeyRound, Languages, Loader2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

import { AuthBackdrop, BrandLogo, DotPulse } from '@/components/auth/LoginAnimation';
import { Turnstile, type TurnstileHandle } from '@/components/auth/Turnstile';
import { Button } from '@/components/ui/button';
import i18n, { setAppLanguage } from '@/i18n';
import { useTranslation } from '@/i18n/useI18n';
import {
	getToken, getEmail, getUsername,
	setToken as storeToken, setEmail as storeEmail, setUsername as storeUsername,
	delToken, delEmail, delUsername,
} from '@/utils/authStore';

const DEFAULT_AUTH_API = 'https://cocode.ohfun.online';
const API_KEY = 'cocode_auth_api';

const authApi = () => (localStorage.getItem(API_KEY) || DEFAULT_AUTH_API).replace(/\/+$/, '');

/** 带 token 的 auth-worker 请求（401 时清掉本地凭证，视为已登出） */
async function authFetch(path: string, init?: RequestInit) {
	const res = await fetch(`${authApi()}${path}`, {
		...init,
		headers: {
			'content-type': 'application/json',
			authorization: `Bearer ${getToken() ?? ''}`,
			...init?.headers,
		},
	});
	if (res.status === 401) {
		await delToken();
		await delEmail();
	}
	return res;
}

/** 图片文件 → 居中裁剪 128px JPEG dataURL（上限内的 worker 才收）。暂未接线（头像上传预留），导出以免 TS6133。 */
export async function fileToAvatar(file: File): Promise<string> {
	const url = URL.createObjectURL(file);
	try {
		const img = new Image();
		await new Promise<void>((resolve, reject) => {
			img.onload = () => resolve();
			img.onerror = () => reject(new Error('图片无法读取'));
			img.src = url;
		});
		const side = Math.min(img.naturalWidth, img.naturalHeight);
		const canvas = document.createElement('canvas');
		canvas.width = canvas.height = 128;
		canvas.getContext('2d')!.drawImage(
			img,
			(img.naturalWidth - side) / 2, (img.naturalHeight - side) / 2, side, side,
			0, 0, 128, 128,
		);
		return canvas.toDataURL('image/jpeg', 0.85);
	} finally {
		URL.revokeObjectURL(url);
	}
}

// ---- 登录/注册卡片共用样式（精修版统一 token）----
/** 输入框：focus 主色描边 + 25% 柔光环，过渡只动 border/shadow */
const FIELD_CLS =
	'h-12 w-full rounded-2xl border border-input bg-background px-4 text-sm outline-none transition-[border-color,box-shadow] duration-200 placeholder:text-muted-foreground focus:border-primary focus:ring-2 focus:ring-primary/25';
/** 主按钮：品牌紫渐变 + 外发光（CoCode × MiniMax 主色统一），禁用整体指针语义 */
const SUBMIT_CLS =
	'btn-brand flex h-11 w-full items-center justify-center rounded-sm text-sm font-medium text-primary-foreground active:scale-[0.98] disabled:pointer-events-none disabled:opacity-40 disabled:shadow-none disabled:filter-none';
/** 返回按钮 */
const BACK_CLS =
	'absolute -left-2 -top-1 rounded-lg p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground';
/** 标题层级 */
const TITLE_CLS = 'text-[21px] font-semibold tracking-[-0.02em]';
/** 错误条：淡入下滑出现，退场收起，避免卡片高度突跳 */
const errorMotion = {
	initial: { opacity: 0, y: -4 },
	animate: { opacity: 1, y: 0 },
	exit: { opacity: 0, y: -4 },
	transition: { duration: 0.18 },
};

/** 带显示/隐藏切换的密码输入（四个密码域共用） */
function PasswordField({
	autoFocus, autoComplete, placeholder, value, onChange, onEnter,
}: {
	autoFocus?: boolean;
	autoComplete: string;
	placeholder: string;
	value: string;
	onChange: (v: string) => void;
	onEnter?: () => void;
}) {
	const { t } = useTranslation();
	const [show, setShow] = useState(false);
	return (
		<div className="relative">
			<input
				type={show ? 'text' : 'password'}
				value={value}
				onChange={(e) => onChange(e.target.value)}
				onKeyDown={(e) => e.key === 'Enter' && onEnter?.()}
				placeholder={placeholder}
				autoFocus={autoFocus}
				autoComplete={autoComplete}
				className={FIELD_CLS + ' pr-12'}
			/>
			<button
				type="button"
				tabIndex={-1}
				aria-label={t(show ? 'settings.account.hidePassword' : 'settings.account.showPassword')}
				onClick={() => setShow((v) => !v)}
				className="absolute right-3 top-1/2 -translate-y-1/2 rounded-md p-1 text-muted-foreground transition-colors hover:text-foreground"
			>
				{show ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
			</button>
		</div>
	);
}

type Step = 'home' | 'password' | 'loginCaptcha' | 'register' | 'registerCaptcha';

/** worker 返回的中文 detail → 当前语言文案（未知消息原样显示）。
 *  登录/注册与账号管理共用一张映射表；顺序敏感（「用户名已被使用」先于通用「已被使用」）。 */
function localizeAuthError(detail: string, t: (key: string) => string): string {
	const map: [RegExp, string][] = [
		[/已注册/, 'settings.account.errors.alreadyRegistered'],
		[/用户名已被使用/, 'settings.account.errors.usernameTaken'],
		[/已被使用/, 'settings.account.errors.emailTaken'],
		[/邮箱格式/, 'settings.account.errors.invalidEmail'],
		[/用户名需为/, 'settings.account.errors.invalidUsername'],
		[/密码至少 8 位/, 'settings.account.errors.shortPassword'],
		[/密码过长/, 'settings.account.errors.longPassword'],
		[/账号或密码错误/, 'settings.account.errors.wrongCredentials'],
		[/邮箱或密码错误/, 'settings.account.errors.wrongCredentials'],
		[/当前密码错误/, 'settings.account.errors.wrongPassword'],
		[/发送过于频繁/, 'settings.account.errors.codeTooFrequent'],
		[/验证码发送失败/, 'settings.account.errors.codeSendFailed'],
		[/人机验证/, 'settings.account.errors.turnstileFailed'],
		[/验证码/, 'settings.account.errors.codeInvalid'],
		[/头像过大/, 'settings.account.errors.avatarTooLarge'],
		[/头像格式/, 'settings.account.errors.avatarInvalid'],
	];
	for (const [re, key] of map) if (re.test(detail)) return t(key);
	return detail;
}

/** 步骤切换过渡（前进方向统一从右滑入） */
const stepMotion = {
	initial: { opacity: 0, x: 28 },
	animate: { opacity: 1, x: 0 },
	exit: { opacity: 0, x: -28 },
	transition: { duration: 0.22, ease: [0.25, 1, 0.5, 1] as const },
};

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
/** 用户名（与服务端 isValidUsername 同规则）：2-32 位字母/数字/下划线/连字符/文字 */
const USERNAME_RE = /^[\p{L}\p{N}_-]{2,32}$/u;

export function AccountSection({ onAuthenticated }: {
	/** 登录/注册成功回调（LoginGate 全屏门槛用；设置窗口内不传） */
	onAuthenticated?: (user: { email: string; createdAt?: string }) => void;
}) {
	const { t } = useTranslation();
	const isZh = i18n.language.startsWith('zh');
	const [step, setStep] = useState<Step>('home');
	const [account, setAccount] = useState(() =>
		getUsername() ?? getEmail() ?? '');
	const [accountFocus, setAccountFocus] = useState(false);
	const [username, setUsername] = useState('');
	const [email, setEmail] = useState('');
	const [password, setPassword] = useState('');
	const [confirm, setConfirm] = useState('');
	const [code, setCode] = useState('');
	const [codeCooldown, setCodeCooldown] = useState(0);
	// Turnstile token（一次性；提交失败后 widget reset 会带回新 token）
	const [loginTs, setLoginTs] = useState('');
	const [registerTs, setRegisterTs] = useState('');
	const loginTsRef = useRef<TurnstileHandle>(null);
	const registerTsRef = useRef<TurnstileHandle>(null);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [user, setUser] = useState<{ email: string; username?: string | null; createdAt?: string; avatar?: string | null } | null>(() => {
		const saved = getEmail();
		return saved
			? { email: saved, username: getUsername() }
			: null;
	});

	// 验证码 60s 重发倒计时
	useEffect(() => {
		if (codeCooldown <= 0) return;
		const timer = window.setInterval(() => setCodeCooldown((s) => (s <= 1 ? 0 : s - 1)), 1000);
		return () => window.clearInterval(timer);
	}, [codeCooldown]);

	// 已有 token 时拉一次最新资料（邮箱/用户名可能改过、头像只存在服务端）
	useEffect(() => {
		if (!getToken()) return;
		let alive = true;
		authFetch('/auth/me')
			.then(async (r) => (r.ok ? await r.json() : null))
			.then(async (b) => {
				if (!alive) return;
				if (!b || !getToken()) { setUser(null); return; }
				await storeEmail(b.email);
				if (b.username) await storeUsername(b.username);
				setUser({ email: b.email, username: b.username, createdAt: b.createdAt, avatar: b.avatar ?? null });
			})
			.catch(() => {});
		return () => { alive = false; };
	}, []);

	/** 首页输入：邮箱或用户名均可（有 @ 按邮箱校验，否则按用户名规则） */
	const accountOk = EMAIL_RE.test(account.trim()) || USERNAME_RE.test(account.trim());

	/** 「登录或注册」：服务端查账号是否已注册，分流到密码页或注册页 */
	const submitAccount = async () => {
		if (!accountOk || busy) return;
		setBusy(true);
		setError(null);
		try {
			const res = await fetch(`${authApi()}/auth/check`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ account: account.trim() }),
			});
			const body = await res.json().catch(() => ({}));
			if (!res.ok) {
				setError(localizeAuthError(String(body?.detail ?? `HTTP ${res.status}`), t));
				return;
			}
			setPassword(''); setConfirm(''); setCode('');
			if (body.registered) {
				setStep('password');
			} else {
				// 未注册：输入的是邮箱 → 预填邮箱；输入的是用户名 → 预填用户名
				if (EMAIL_RE.test(account.trim())) { setEmail(account.trim()); setUsername(''); }
				else { setUsername(account.trim()); setEmail(''); }
				setStep('register');
			}
		} catch (e) {
			setError(localizeAuthError(e instanceof Error ? e.message : String(e), t));
		} finally {
			setBusy(false);
		}
	};

	/** 注册：用户名 + 邮箱 + 密码 + 邮箱验证码 */
	/** 注册字段本地校验（「继续」按钮与最终提交共用） */
	const validateRegister = () => {
		if (!USERNAME_RE.test(username.trim())) { setError(t('settings.account.errors.invalidUsername')); return false; }
		if (!EMAIL_RE.test(email.trim())) { setError(t('settings.account.errors.invalidEmail')); return false; }
		if (password.length < 8) { setError(t('settings.account.errors.shortPassword')); return false; }
		if (password !== confirm) { setError(t('settings.account.errors.confirmMismatch')); return false; }
		if (!code.trim()) { setError(t('settings.account.errors.codeInvalid')); return false; }
		return true;
	};

	const submitRegister = async () => {
		if (busy) return;
		// 防御：字段被绕过校验改动时退回表单页
		if (!validateRegister()) { setStep('register'); return; }
		setBusy(true);
		setError(null);
		try {
			const res = await fetch(`${authApi()}/auth/register`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({
					email: email.trim(), username: username.trim(), password, code: code.trim(),
					'cf-turnstile-response': registerTs,
				}),
			});
			const body = await res.json().catch(() => ({}));
			if (!res.ok) {
				setError(localizeAuthError(String(body?.detail ?? `HTTP ${res.status}`), t));
				// token 一次性：无论何种失败都 reset 换新，保证可重试
				registerTsRef.current?.reset();
				return;
			}
			await storeToken(body.token);
			await storeEmail(body.email);
			await storeUsername(body.username ?? '');
			setUser({ email: body.email, username: body.username, createdAt: body.createdAt, avatar: body.avatar ?? null });
			onAuthenticated?.({ email: body.email, createdAt: body.createdAt });
			setStep('home');
		} catch (e) {
			setError(localizeAuthError(e instanceof Error ? e.message : String(e), t));
		} finally {
			setBusy(false);
		}
	};

	/** 登录：用户名或邮箱 + 密码 */
	const submitLogin = async () => {
		if (busy || !password) return;
		setBusy(true);
		setError(null);
		try {
			const res = await fetch(`${authApi()}/auth/login`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({
					account: account.trim(), password,
					'cf-turnstile-response': loginTs,
				}),
			});
			const body = await res.json().catch(() => ({}));
			if (!res.ok) {
				setError(localizeAuthError(String(body?.detail ?? `HTTP ${res.status}`), t));
				// token 一次性：失败后 reset 换新，保证可重试
				loginTsRef.current?.reset();
				return;
			}
			await storeToken(body.token);
			await storeEmail(body.email);
			await storeUsername(body.username ?? '');
			setUser({ email: body.email, username: body.username, createdAt: body.createdAt, avatar: body.avatar ?? null });
			onAuthenticated?.({ email: body.email, createdAt: body.createdAt });
			setStep('home');
		} catch (e) {
			setError(localizeAuthError(e instanceof Error ? e.message : String(e), t));
		} finally {
			setBusy(false);
		}
	};

	/** 发送邮箱验证码（仅未注册邮箱；60s 冷却由服务端与前端双重限制） */
	const sendCode = async () => {
		if (busy || codeCooldown > 0) return;
		if (!EMAIL_RE.test(email.trim())) { setError(t('settings.account.errors.invalidEmail')); return; }
		setBusy(true);
		setError(null);
		try {
			const res = await fetch(`${authApi()}/auth/code`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ email: email.trim() }),
			});
			const body = await res.json().catch(() => ({}));
			if (!res.ok) {
				setError(localizeAuthError(String(body?.detail ?? `HTTP ${res.status}`), t));
				return;
			}
			setCodeCooldown(60);
		} catch (e) {
			setError(localizeAuthError(e instanceof Error ? e.message : String(e), t));
		} finally {
			setBusy(false);
		}
	};

	const logout = async () => {
		const token = getToken();
		if (token) {
			await fetch(`${authApi()}/auth/logout`, {
				method: 'POST',
				headers: { authorization: `Bearer ${token}` },
			}).catch(() => {});
		}
		await delToken();
		await delEmail();
		await delUsername();
		setUser(null);
		setPassword('');
		setConfirm('');
	};

	// 已登录：账号管理视图（设置窗口）——不含登录卡片背景
	if (user) {
		return (
			<AccountManager
				user={user}
				onEmailChanged={async (em) => {
					await storeEmail(em);
					setUser((u) => (u ? { ...u, email: em } : u));
				}}
				onAvatarChanged={(av) => {
					setUser((u) => (u ? { ...u, avatar: av } : u));
				}}
				onLogout={() => void logout()}
			/>
		);
	}


	return (
		<div className="app-drag relative flex h-full w-full items-center justify-center overflow-hidden">
			<AuthBackdrop />

			{onAuthenticated ? (
				<button
					type="button"
					onClick={() => void setAppLanguage(isZh ? 'en' : 'zh')}
					aria-label={isZh ? t('common.switchToEn') : t('common.switchToZh')}
					className="app-no-drag absolute right-5 top-5 z-30 flex h-9 items-center gap-2 rounded-rect border border-border bg-background/90 px-3 text-xs font-medium text-foreground shadow-sm backdrop-blur transition-colors hover:bg-muted"
				>
					<Languages className="size-4 text-muted-foreground" />
					<span>{isZh ? t('common.switchToEn') : t('common.switchToZh')}</span>
				</button>
			) : null}

			<motion.div
				initial={{ opacity: 0, y: 24, scale: 0.97 }}
				animate={{ opacity: 1, y: 0, scale: 1 }}
				transition={{ duration: 0.55, ease: [0.16, 1, 0.3, 1] }}
				className="app-no-drag relative z-10 w-full max-w-[360px] rounded-3xl border border-border bg-popover p-8 shadow-[0_24px_80px_-24px_rgb(0_0_0/0.35)]"
			>
				<AnimatePresence mode="wait" initial={false}>
					{step === 'home' ? (
						// ---------- 首页：用户名/邮箱 → 服务端分流登录或注册 ----------
						<motion.div key="home" {...stepMotion} className="flex flex-col items-center text-center">
							<BrandLogo />
							<h3 className={TITLE_CLS + ' mt-5'}>{t('settings.account.homeTitle')}</h3>
							<div className="mt-1.5 text-xs text-muted-foreground">{t('settings.account.homeDesc')}</div>

							{/* 账号输入：浮动标签弹起 + 聚焦光圈扩散 */}
							<div className="relative mt-6 w-full">
								<input
									autoCapitalize="off"
									autoCorrect="off"
									spellCheck={false}
									autoComplete="username"
									value={account}
									onChange={(e) => setAccount(e.target.value)}
									onFocus={() => setAccountFocus(true)}
									onBlur={() => setAccountFocus(false)}
									onKeyDown={(e) => e.key === 'Enter' && void submitAccount()}
									className="h-14 w-full rounded-2xl border border-input bg-background px-4 pt-5 text-sm outline-none transition-[border-color,box-shadow] placeholder:text-transparent"
								/>
								{/* 聚焦光圈：淡入 + 微缩放 */}
								<motion.span
									aria-hidden
									initial={false}
									animate={{ opacity: accountFocus ? 1 : 0, scale: accountFocus ? 1 : 0.97 }}
									transition={{ duration: 0.18 }}
									className="pointer-events-none absolute inset-0 rounded-2xl border-2 border-primary"
								/>
								{/* 浮动标签：占位（居中）↔ 浮起（上缘缩小变主色） */}
								<motion.label
									initial={false}
									animate={{
										y: accountFocus || account ? 7 : 18,
										scale: accountFocus || account ? 0.72 : 1,
									}}
									transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
									style={{ transformOrigin: 'left top', x: 14 }}
									className={
										'pointer-events-none absolute left-0 top-0 text-sm transition-colors duration-200 ' +
										(accountFocus ? 'text-primary' : 'text-muted-foreground')
									}
								>
									{accountFocus || account ? t('settings.account.accountLabel') : t('settings.account.accountPlaceholder')}
								</motion.label>
							</div>

							<button
								type="button"
								disabled={!accountOk || busy}
								onClick={() => void submitAccount()}
								className={SUBMIT_CLS + ' mt-5'}
							>
								{busy && <DotPulse className="mr-2" />}
								{t('settings.account.continue')}
							</button>

							<AnimatePresence>
								{error && (
									<motion.p {...errorMotion} className="mt-4 text-center text-xs text-destructive">{error}</motion.p>
								)}
							</AnimatePresence>

							<p className="mt-6 text-center text-[11px] leading-relaxed text-muted-foreground">{t('settings.account.terms')}</p>
						</motion.div>
					) : step === 'password' ? (
						// ---------- 密码页（已注册账号登录；仅输入密码，人机验证在下一步） ----------
						<motion.div key="password" {...stepMotion} className="relative flex flex-col text-center">
							<button
								type="button"
								aria-label={t('settings.account.back')}
								className={BACK_CLS}
								onClick={() => { setStep('home'); setError(null); }}
							>
								<ArrowLeft className="size-4" />
							</button>

							<h3 className={TITLE_CLS}>{t('settings.account.passwordTitle')}</h3>
							<p className="mx-auto mt-2 max-w-full truncate rounded-rect-sm bg-muted px-3 py-1 text-xs text-muted-foreground">{account.trim()}</p>

							<PasswordField
								autoFocus
								autoComplete="current-password"
								placeholder={t('settings.account.passwordLabel')}
								value={password}
								onChange={setPassword}
								onEnter={() => { if (password) { setError(null); setLoginTs(''); setStep('loginCaptcha'); } }}
							/>

							<button
								type="button"
								disabled={!password}
								onClick={() => { setError(null); setLoginTs(''); setStep('loginCaptcha'); }}
								className={SUBMIT_CLS + ' mt-4'}
							>
								{t('settings.account.nextStep')}
							</button>

							<AnimatePresence>
								{error && (
									<motion.p {...errorMotion} className="mt-4 text-center text-xs text-destructive">{error}</motion.p>
								)}
							</AnimatePresence>
						</motion.div>
					) : step === 'loginCaptcha' ? (
						// ---------- 登录人机验证页（Turnstile 单独一步，通过后提交登录） ----------
						<motion.div key="loginCaptcha" {...stepMotion} className="relative flex flex-col text-center">
							<button
								type="button"
								aria-label={t('settings.account.back')}
								className={BACK_CLS}
								onClick={() => { setStep('password'); setError(null); setLoginTs(''); }}
							>
								<ArrowLeft className="size-4" />
							</button>

							<h3 className={TITLE_CLS}>{t('settings.account.captchaTitle')}</h3>
							<p className="mx-auto mt-2 max-w-full truncate rounded-rect-sm bg-muted px-3 py-1 text-xs text-muted-foreground">{account.trim()}</p>
							<p className="mt-2 text-xs text-muted-foreground">{t('settings.account.captchaLoginDesc')}</p>

							<Turnstile ref={loginTsRef} action="login" onToken={setLoginTs} />

							<button
								type="button"
								disabled={busy || !loginTs}
								onClick={() => void submitLogin()}
								className={SUBMIT_CLS}
							>
								{busy && <DotPulse className="mr-2" />}
								{t('settings.account.login')}
							</button>

							<AnimatePresence>
								{error && (
									<motion.p {...errorMotion} className="mt-4 text-center text-xs text-destructive">{error}</motion.p>
								)}
							</AnimatePresence>
						</motion.div>
					) : step === 'register' ? (
						// ---------- 注册表单页：用户名 + 邮箱 + 密码 + 邮箱验证码（人机验证在下一步） ----------
						<motion.div key="register" {...stepMotion} className="relative flex flex-col">
							<button
								type="button"
								aria-label={t('settings.account.back')}
								className={BACK_CLS}
								onClick={() => { setStep('home'); setError(null); }}
							>
								<ArrowLeft className="size-4" />
							</button>

							<div className="text-center">
								<h3 className={TITLE_CLS}>{t('settings.account.registerTitle')}</h3>
								<p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">{t('settings.account.emailDesc')}</p>
							</div>

							{/* 字段组：gap 统一节奏，替代逐个 margin */}
							<div className="mt-5 flex flex-col gap-3">
								<input
									autoCapitalize="off"
									autoCorrect="off"
									spellCheck={false}
									autoComplete="username"
									autoFocus
									value={username}
									onChange={(e) => setUsername(e.target.value)}
									placeholder={t('settings.account.usernameLabel')}
									className={FIELD_CLS}
								/>
								<input
									type="email"
									autoCapitalize="off"
									autoCorrect="off"
									spellCheck={false}
									autoComplete="email"
									value={email}
									onChange={(e) => setEmail(e.target.value)}
									placeholder={t('settings.account.emailLabel')}
									className={FIELD_CLS}
								/>
								<PasswordField
									autoComplete="new-password"
									placeholder={t('settings.account.passwordLabel')}
									value={password}
									onChange={setPassword}
								/>
								<PasswordField
									autoComplete="new-password"
									placeholder={t('settings.account.confirmLabel')}
									value={confirm}
									onChange={setConfirm}
								/>

								{/* 验证码：输入框 + 发送按钮（60s 冷却倒计时） */}
								<div className="flex gap-2">
									<input
										inputMode="numeric"
										autoComplete="one-time-code"
										value={code}
										onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
										onKeyDown={(e) => e.key === 'Enter' && validateRegister() && (setError(null), setRegisterTs(''), setStep('registerCaptcha'))}
										placeholder={t('settings.account.codeLabel')}
										className="h-12 min-w-0 flex-1 rounded-2xl border border-input bg-background px-4 text-sm tracking-[0.3em] outline-none transition-[border-color,box-shadow] placeholder:tracking-normal placeholder:text-muted-foreground focus:border-primary focus:ring-2 focus:ring-primary/25"
									/>
									<button
										type="button"
										disabled={busy || codeCooldown > 0 || !EMAIL_RE.test(email.trim())}
										onClick={() => void sendCode()}
										className="h-12 shrink-0 rounded-2xl border border-border px-4 text-xs font-medium text-foreground transition-colors hover:bg-muted active:scale-[0.98] disabled:pointer-events-none disabled:opacity-40"
									>
										{codeCooldown > 0
											? t('settings.account.codeCooldown', { s: codeCooldown })
											: t('settings.account.sendCode')}
									</button>
								</div>
							</div>

							<button
								type="button"
								disabled={busy}
								onClick={() => { if (validateRegister()) { setError(null); setRegisterTs(''); setStep('registerCaptcha'); } }}
								className={SUBMIT_CLS + ' mt-5'}
							>
								{t('settings.account.nextStep')}
							</button>

							<AnimatePresence>
								{error && (
									<motion.p {...errorMotion} className="mt-3 text-center text-xs text-destructive">{error}</motion.p>
								)}
							</AnimatePresence>
						</motion.div>
					) : (
						// ---------- 注册人机验证页（Turnstile 单独一步，通过后创建账号） ----------
						<motion.div key="registerCaptcha" {...stepMotion} className="relative flex flex-col text-center">
							<button
								type="button"
								aria-label={t('settings.account.back')}
								className={BACK_CLS}
								onClick={() => { setStep('register'); setError(null); setRegisterTs(''); }}
							>
								<ArrowLeft className="size-4" />
							</button>

							<h3 className={TITLE_CLS}>{t('settings.account.captchaTitle')}</h3>
							<p className="mx-auto mt-2 max-w-full truncate rounded-rect-sm bg-muted px-3 py-1 text-xs text-muted-foreground">{email.trim() || username.trim()}</p>
							<p className="mt-2 text-xs text-muted-foreground">{t('settings.account.captchaRegisterDesc')}</p>

							<Turnstile ref={registerTsRef} action="register" onToken={setRegisterTs} />

							<button
								type="button"
								disabled={busy || !registerTs}
								onClick={() => void submitRegister()}
								className={SUBMIT_CLS}
							>
								{busy && <DotPulse className="mr-2" />}
								{t('settings.account.createAccount')}
							</button>

							<AnimatePresence>
								{error && (
									<motion.p {...errorMotion} className="mt-3 text-center text-xs text-destructive">{error}</motion.p>
								)}
							</AnimatePresence>
						</motion.div>
					)}
				</AnimatePresence>
			</motion.div>
		</div>
	);
}

// ==================== 账号管理（设置窗口 · 已登录） ====================

const INPUT_CLS =
	'h-10 w-full rounded-lg border border-input bg-muted px-3 text-sm outline-none placeholder:text-muted-foreground focus:ring-2 focus:ring-ring';

/** 可展开的设置行（修改密码 / 修改邮箱共用骨架） */
function CollapseRow({
	icon: Icon,
	label,
	open,
	busy,
	children,
	onToggle,
}: {
	icon: typeof KeyRound;
	label: string;
	open: boolean;
	busy?: boolean;
	children: React.ReactNode;
	onToggle: () => void;
}) {
	return (
		<div className="overflow-hidden rounded-xl border border-border bg-card">
			<button
				type="button"
				className="flex w-full items-center gap-3 px-5 py-3.5 text-left transition-colors hover:bg-muted"
				onClick={onToggle}
			>
				<Icon className="size-4 shrink-0 text-muted-foreground" />
				<span className="flex-1 text-sm font-medium">{label}</span>
				{busy && <Loader2 className="size-3.5 animate-spin text-muted-foreground" />}
				<ChevronDown className={`size-4 text-muted-foreground transition-transform duration-200 ${open ? 'rotate-180' : ''}`} />
			</button>
			<AnimatePresence initial={false}>
				{open && (
					<motion.div
						initial={{ height: 0, opacity: 0 }}
						animate={{ height: 'auto', opacity: 1 }}
						exit={{ height: 0, opacity: 0 }}
						transition={{ duration: 0.22, ease: [0.25, 1, 0.5, 1] }}
					>
						<div className="border-t border-border px-5 pb-4 pt-4">{children}</div>
					</motion.div>
				)}
			</AnimatePresence>
		</div>
	);
}

function AccountManager({
	user,
	onEmailChanged,
	onAvatarChanged,
	onLogout,
}: {
	user: { email: string; username?: string | null; createdAt?: string; avatar?: string | null };
	onEmailChanged: (email: string) => void | Promise<void>;
	onAvatarChanged?: (avatar: string | null) => void;
	onLogout: () => void;
}) {
	const { t } = useTranslation();
	const [avatar, setAvatar] = useState(user.avatar ?? null);
	const [avatarBusy, setAvatarBusy] = useState(false);

	// user.avatar 由父组件异步拉取（/auth/me），晚于本组件挂载；本地 avatar
	// 需跟随其变化，否则有历史头像的用户打开设置仍显示首字母占位。
	useEffect(() => {
		setAvatar(user.avatar ?? null);
	}, [user.avatar]);
	const [panel, setPanel] = useState<'none' | 'password' | 'email'>('none');
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [note, setNote] = useState<string | null>(null);

	const [curPwd, setCurPwd] = useState('');
	const [newPwd, setNewPwd] = useState('');
	const [newPwd2, setNewPwd2] = useState('');
	const [emailPwd, setEmailPwd] = useState('');
	const [newEmail, setNewEmail] = useState('');
	const fileRef = useRef<HTMLInputElement>(null);

	const flashNote = (msg: string) => {
		setNote(msg);
		window.setTimeout(() => setNote((cur) => (cur === msg ? null : cur)), 3000);
	};

	const fail = (e: unknown) => {
		setError(localizeAuthError(e instanceof Error ? e.message : String(e), t));
	};

	const pickAvatar = async (file: File | undefined) => {
		if (!file) return;
		setAvatarBusy(true);
		setError(null);
		setNote(null);
		try {
			const dataUrl = await fileToAvatar(file);
			const res = await authFetch('/auth/avatar', { method: 'POST', body: JSON.stringify({ avatar: dataUrl }) });
			const body = await res.json().catch(() => ({}));
			if (!res.ok) throw new Error(String(body?.detail ?? `HTTP ${res.status}`));
			const next = body.avatar ?? dataUrl;
			setAvatar(next);
			onAvatarChanged?.(next); // 回写父组件，重挂载后仍保持最新头像
			flashNote(t('settings.account.manager.avatarSaved'));
		} catch (e) {
			fail(e);
		} finally {
			setAvatarBusy(false);
		}
	};

	const submitPassword = async () => {
		if (newPwd !== newPwd2) { setError(t('settings.account.errors.confirmMismatch')); return; }
		if (newPwd.length < 8) { setError(t('settings.account.errors.shortPassword')); return; }
		setBusy(true);
		setError(null);
		try {
			const res = await authFetch('/auth/password', {
				method: 'POST',
				body: JSON.stringify({ currentPassword: curPwd, newPassword: newPwd }),
			});
			const body = await res.json().catch(() => ({}));
			if (!res.ok) throw new Error(String(body?.detail ?? `HTTP ${res.status}`));
			setPanel('none');
			setCurPwd(''); setNewPwd(''); setNewPwd2('');
			flashNote(t('settings.account.manager.passwordSaved'));
		} catch (e) {
			fail(e);
		} finally {
			setBusy(false);
		}
	};

	const submitEmail = async () => {
		if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(newEmail.trim())) {
			setError(t('settings.account.errors.invalidEmail'));
			return;
		}
		setBusy(true);
		setError(null);
		try {
			const res = await authFetch('/auth/email', {
				method: 'POST',
				body: JSON.stringify({ currentPassword: emailPwd, newEmail: newEmail.trim() }),
			});
			const body = await res.json().catch(() => ({}));
			if (!res.ok) throw new Error(String(body?.detail ?? `HTTP ${res.status}`));
			onEmailChanged(body.email ?? newEmail.trim());
			setPanel('none');
			setEmailPwd(''); setNewEmail('');
			flashNote(t('settings.account.manager.emailSaved'));
		} catch (e) {
			fail(e);
		} finally {
			setBusy(false);
		}
	};

	const toggle = (p: 'password' | 'email') => {
		setPanel((cur) => (cur === p ? 'none' : p));
		setError(null);
	};

	const initial = (user.username || user.email).trim().charAt(0).toUpperCase();

	return (
		<div className="mx-auto w-full max-w-md">
			{/* 资料卡：头像（点击更换） + 邮箱 + 注册时间 */}
			<div className="flex items-center gap-4 rounded-xl border border-border bg-card px-5 py-4">
				<button
					type="button"
					aria-label={t('settings.account.manager.changeAvatar')}
					className="group relative size-16 shrink-0 overflow-hidden rounded-sm border border-border bg-muted"
					onClick={() => fileRef.current?.click()}
				>
					{avatar ? (
						<img src={avatar} alt="" className="size-full object-cover" draggable={false} />
					) : (
						<span className="flex size-full items-center justify-center text-xl font-semibold text-muted-foreground">{initial}</span>
					)}
					{avatarBusy ? (
						<span className="absolute inset-0 flex items-center justify-center bg-scrim">
							<Loader2 className="size-4 animate-spin text-white" />
						</span>
					) : (
						<span className="absolute inset-0 hidden items-center justify-center bg-scrim text-white group-hover:flex">
							<Camera className="size-4" />
						</span>
					)}
				</button>
				<input
					ref={fileRef}
					type="file"
					accept="image/png,image/jpeg,image/webp"
					className="hidden"
					onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; void pickAvatar(f); }}
				/>
				<div className="min-w-0">
					<div className="truncate text-sm font-semibold">{user.username || user.email}</div>
					{user.username && user.email && (
						<div className="mt-0.5 truncate text-xs text-muted-foreground">{user.email}</div>
					)}
					{user.createdAt && (
						<div className="mt-0.5 text-xs text-muted-foreground">
							{t('settings.account.since', { date: user.createdAt.slice(0, 10) })}
						</div>
					)}
					<div className="mt-0.5 text-[11px] text-muted-foreground">{t('settings.account.manager.avatarHint')}</div>
				</div>
			</div>

			{/* 操作反馈条 */}
			{note && (
				<div className="mt-3 rounded-md border border-emerald-500 bg-emerald-50 dark:bg-emerald-950 px-3 py-2 text-xs text-emerald-600 dark:text-emerald-400">
					{note}
				</div>
			)}
			{error && (
				<div className="mt-3 rounded-md border border-destructive bg-destructive-soft px-3 py-2 text-xs text-destructive">
					{error}
				</div>
			)}

			{/* 修改密码 */}
			<div className="mt-3">
				<CollapseRow
					icon={KeyRound}
					label={t('settings.account.manager.changePassword')}
					open={panel === 'password'}
					busy={busy && panel === 'password'}
					onToggle={() => toggle('password')}
				>
					<div className="space-y-2.5">
						<input type="password" value={curPwd} onChange={(e) => setCurPwd(e.target.value)}
							placeholder={t('settings.account.manager.currentPassword')} className={INPUT_CLS} />
						<input type="password" value={newPwd} onChange={(e) => setNewPwd(e.target.value)}
							placeholder={t('settings.account.manager.newPassword')} className={INPUT_CLS} />
						<input type="password" value={newPwd2} onChange={(e) => setNewPwd2(e.target.value)}
							placeholder={t('settings.account.confirmLabel')} className={INPUT_CLS}
							onKeyDown={(e) => e.key === 'Enter' && void submitPassword()} />
						<Button type="button" size="sm" disabled={busy || !curPwd || !newPwd || !newPwd2} onClick={() => void submitPassword()}>
							{t('settings.account.manager.save')}
						</Button>
					</div>
				</CollapseRow>
			</div>

			{/* 修改邮箱 */}
			<div className="mt-3">
				<CollapseRow
					icon={AtSign}
					label={t('settings.account.manager.changeEmail')}
					open={panel === 'email'}
					busy={busy && panel === 'email'}
					onToggle={() => toggle('email')}
				>
					<div className="space-y-2.5">
						<div className="text-xs text-muted-foreground">{t('settings.account.manager.currentEmail', { email: user.email })}</div>
						<input type="email" value={newEmail} onChange={(e) => setNewEmail(e.target.value)}
							placeholder={t('settings.account.manager.newEmail')} className={INPUT_CLS} />
						<input type="password" value={emailPwd} onChange={(e) => setEmailPwd(e.target.value)}
							placeholder={t('settings.account.manager.currentPassword')} className={INPUT_CLS}
							onKeyDown={(e) => e.key === 'Enter' && void submitEmail()} />
						<Button type="button" size="sm" disabled={busy || !newEmail.trim() || !emailPwd} onClick={() => void submitEmail()}>
							{t('settings.account.manager.save')}
						</Button>
					</div>
				</CollapseRow>
			</div>

			{/* 退出登录 */}
			<Button type="button" variant="outline" className="mt-4 w-full text-destructive hover:bg-destructive-soft" onClick={onLogout}>
				{t('settings.account.logout')}
			</Button>
		</div>
	);
}
