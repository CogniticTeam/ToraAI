import { useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';

import { ChatViewport } from './ChatViewport';
import { hasFreshlyCreated } from '@/api/session';
import { AudioProvider } from '@/context/AudioContext';
import { useAgents } from '@/hooks/useAgents';
import { useSessions } from '@/hooks/useSessions';

/**
 * The chat page's outer shell (CoCode 定制版):
 *
 * 历史会话列表已迁入全局侧栏（AppSidebar 的 SessionListSection），
 * 智能体选择器与其设置已迁入设置窗口——本页不再渲染自己的侧栏，
 * 只负责 URL → (agent, session) 的解析、记忆与重定向，以及挂载
 * ChatViewport。
 */
/** localStorage keys holding the last (agent, session) the user viewed. */
const LAST_AGENT_KEY = 'chat_last_agent';
const LAST_SESSION_KEY = 'chat_last_session';

const ChatPageInner = () => {
	const navigate = useNavigate();
	const {
		agentId: urlAgentId,
		sessionId: urlSessionId,
		memberId: urlMemberId,
	} = useParams<{
		agentId?: string;
		sessionId?: string;
		memberId?: string;
	}>();
	const { agents } = useAgents();
	const { sessions, refetch: refetchSessions } = useSessions(urlAgentId ?? null);

	const currentView = sessions.find((v) => v.session.id === urlSessionId) ?? null;

	// "Inner focus" — when the URL carries a third `:memberId` segment
	// the user is drilling into a team member's chat. When `urlMemberId`
	// is undefined or doesn't resolve to a known team member, the inner
	// focus collapses back to the outer (leader) session.
	const focusedMember = urlMemberId
		? (currentView?.team?.members.find((m) => m.agent.id === urlMemberId) ?? null)
		: null;
	const effectiveAgentId =
		focusedMember && focusedMember.session_id ? focusedMember.agent.id : (urlAgentId ?? null);
	// 本 tab 刚创建、还没进列表缓存的新会话：它必然存在、也没有可拉的
	// 历史，允许先行翻转。否则 sessionId 会一直卡在 null——SSE 连不上、
	// 回复没有通道、界面停在"发了消息但毫无反应"的空窗，直到窗口重新
	// 获得焦点触发列表 refetch 才能翻身。
	const isFreshSession = urlSessionId ? hasFreshlyCreated(urlSessionId) : false;
	// 先行翻转是瞬态标志（接管后即消失），而列表缓存要一次网络往返才含
	// 新会话——中间若有无关重渲染，光看 isFreshSession 会把已翻转的
	// sessionId 打回 null，useMessages 随之重置、刚接管的消息凭空消失。
	// 翻转过就粘住，直到 URL 指向别的会话。用渲染期派生 state（React
	// 官方支持的同组件 setState 模式）记忆，而非 ref。
	const [stickySessionId, setStickySessionId] = useState<string | null>(null);
	if (urlSessionId && (currentView || isFreshSession) && urlSessionId !== stickySessionId) {
		setStickySessionId(urlSessionId);
	}
	const stickyFlipped = urlSessionId !== null && urlSessionId === stickySessionId;
	const effectiveSessionId =
		focusedMember && focusedMember.session_id
			? focusedMember.session_id
			: currentView || isFreshSession || stickyFlipped
				? (urlSessionId ?? null)
				: null;

	// Remember where the user was, so coming back to a bare `/chat` —
	// from another page, or from a new tab — reopens it instead of
	// making them pick the same pair again.
	useEffect(() => {
		if (!urlAgentId || !urlSessionId) return;
		localStorage.setItem(LAST_AGENT_KEY, urlAgentId);
		localStorage.setItem(LAST_SESSION_KEY, urlSessionId);
	}, [urlAgentId, urlSessionId]);

	// Redirect: URL is missing an agent → reopen the last one viewed,
	// falling back to the first, and rewrite the URL in-place (replace
	// so we don't pollute history).
	//
	// 记住的会话一并带上：上次看到哪个会话，启动就回到哪个 —— 而不是每次
	// 启动都丢一个空会话出来。带上的 id 若已失效（会话被删/记忆过期），
	// 由下面的校正 effect 修剪。
	useEffect(() => {
		if (urlAgentId || agents.length === 0) return;
		const rememberedAgent = localStorage.getItem(LAST_AGENT_KEY);
		const rememberedSession = localStorage.getItem(LAST_SESSION_KEY);
		const agent = agents.find((a) => a.id === rememberedAgent) ?? agents[0];
		navigate(
			rememberedSession ? `/chat/${agent.id}/${rememberedSession}` : `/chat/${agent.id}`,
			{ replace: true },
		);
	}, [agents, urlAgentId, navigate]);

	// URL 里的 agentId 已不存在（agent 被删/数据被清后本地缓存残留）→
	// 落回第一个可用 agent。否则发消息时后端 404 "agent 不存在"，
	// 用户被卡死在无解释的报错里。与上面 bare-/chat 的记忆恢复同一策略：
	// replace 重写，不污染历史。
	useEffect(() => {
		if (!urlAgentId || agents.length === 0) return;
		if (agents.some((a) => a.id === urlAgentId)) return;
		navigate(`/chat/${agents[0].id}`, { replace: true });
	}, [agents, urlAgentId, navigate]);

	// 恢复的会话可能已经不存在（被删、跨 profile 残留）。URL 指着一个死 id
	// 时永远落空视图，且 remember effect 会一直续写这条死记忆 —— 修剪掉。
	// 只针对「启动时记忆恢复的那个 id」判定：此后 URL 都是活操作
	// （新建会话/onSessionCreated/点列表）写出来的——尤其是刚建好就跳过来
	// 的新会话，列表 refetch 还没落地时不含它，误判会把用户从新会话里踢回
	// 空态，只能再去列表手动点进去。
	const prunedRef = useRef(false);
	const restoredSessionRef = useRef(localStorage.getItem(LAST_SESSION_KEY));
	useEffect(() => {
		if (prunedRef.current) return;
		if (!urlAgentId || !urlSessionId) return;
		if (urlSessionId !== restoredSessionRef.current) {
			// URL 指向的不是启动恢复的会话，而是活操作写出来的 —— 无需修剪。
			prunedRef.current = true;
			return;
		}
		if (sessions.length === 0) return; // 列表未到，先别判死刑
		prunedRef.current = true;
		if (sessions.some((v) => v.session.id === urlSessionId)) return;
		localStorage.removeItem(LAST_SESSION_KEY);
		navigate(`/chat/${urlAgentId}`, { replace: true });
	}, [urlAgentId, urlSessionId, sessions, navigate]);

	// No redirect when the agent is set but the session isn't (or the
	// session id no longer resolves). Instead we keep the empty view
	// alive and let ``useMessages.send`` create a brand-new session on
	// the first message — the host rewrites the URL via
	// ``onSessionCreated`` so a reload lands the user back in the
	// conversation they just started.
	useEffect(() => {
		// intentionally empty — kept as an anchor for future pre-send hooks
	}, [urlAgentId]);

	return (
		<div className="flex h-full w-full bg-transparent">
			<div className="flex flex-1 min-w-0">
				<ChatViewport
					agentId={effectiveAgentId}
					sessionId={effectiveSessionId}
					onSessionsChanged={refetchSessions}
					onSessionCreated={(newId) => {
						if (urlAgentId) {
							navigate(`/chat/${urlAgentId}/${newId}`, { replace: true });
						}
						// 新会话还不在列表缓存里，而 model/cwd 等展示都挂在
						// view 上——立即拉一次，别等 focus 事件来救场。
						void refetchSessions();
					}}
				/>
			</div>
		</div>
	);
};

export const ChatPage = () => (
	<AudioProvider>
		<ChatPageInner />
	</AudioProvider>
);
