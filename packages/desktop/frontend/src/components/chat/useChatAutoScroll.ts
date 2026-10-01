import { useCallback, useLayoutEffect, useRef, type KeyboardEvent, type WheelEvent } from 'react';

/** 允许几像素的排版/缩放误差，避免贴底状态在流式回复中反复切换。 */
const BOTTOM_THRESHOLD = 48;

/**
 * 跟随新消息和流式回复；用户上滑阅读历史时暂停，回到底部后自动恢复。
 * 滚动采用即时定位，避免每个 token 都启动一次 smooth 动画而产生追赶和卡顿。
 */
export function useChatAutoScroll(active: boolean) {
	const viewportRef = useRef<HTMLDivElement | null>(null);
	const contentRef = useRef<HTMLDivElement | null>(null);
	const followingRef = useRef(true);
	const previousTopRef = useRef(0);
	const frameRef = useRef<number | null>(null);

	const atBottom = useCallback(() => {
		const viewport = viewportRef.current;
		return !viewport || viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop <= BOTTOM_THRESHOLD;
	}, []);

	const scrollToBottom = useCallback(() => {
		const viewport = viewportRef.current;
		if (!viewport) return;
		viewport.scrollTop = viewport.scrollHeight;
		previousTopRef.current = viewport.scrollTop;
	}, []);

	const scheduleFollow = useCallback(() => {
		if (!followingRef.current || frameRef.current !== null) return;
		frameRef.current = requestAnimationFrame(() => {
			frameRef.current = null;
			if (followingRef.current) scrollToBottom();
		});
	}, [scrollToBottom]);

	const resume = useCallback(() => {
		followingRef.current = true;
		scheduleFollow();
	}, [scheduleFollow]);

	const onScroll = useCallback(() => {
		const viewport = viewportRef.current;
		if (!viewport) return;
		if (atBottom()) followingRef.current = true;
		else if (viewport.scrollTop < previousTopRef.current - 1) followingRef.current = false;
		previousTopRef.current = viewport.scrollTop;
	}, [atBottom]);

	const onWheel = useCallback((event: WheelEvent<HTMLDivElement>) => {
		if (event.deltaY < 0) followingRef.current = false;
		else if (atBottom()) followingRef.current = true;
	}, [atBottom]);

	const onKeyDown = useCallback((event: KeyboardEvent<HTMLDivElement>) => {
		if (['ArrowUp', 'PageUp', 'Home'].includes(event.key)) followingRef.current = false;
		else if (event.key === 'End') resume();
	}, [resume]);

	useLayoutEffect(() => {
		if (!active) {
			followingRef.current = true;
			previousTopRef.current = 0;
			return;
		}
		const viewport = viewportRef.current;
		const content = contentRef.current;
		if (!viewport || !content) return;
		// 新会话/历史加载完成时先定位到底部，然后监听正文和视口的尺寸变化。
		followingRef.current = true;
		scrollToBottom();
		const observer = new ResizeObserver(scheduleFollow);
		observer.observe(content);
		observer.observe(viewport);
		return () => {
			observer.disconnect();
			if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
			frameRef.current = null;
		};
	}, [active, scheduleFollow, scrollToBottom]);

	return { viewportRef, contentRef, onScroll, onWheel, onKeyDown, pause: () => { followingRef.current = false; }, resume, scheduleFollow };
}
