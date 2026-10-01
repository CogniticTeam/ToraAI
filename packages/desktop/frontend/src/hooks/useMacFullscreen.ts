import { useEffect, useState } from 'react';

type WindowBridge = {
	platform?: string;
	isFullScreen?: () => boolean;
	onMaximizeChange?: (callback: (expanded: boolean) => void) => (() => void) | void;
};

const bridge = (window as unknown as { toraWindow?: WindowBridge }).toraWindow;
const readFullscreen = () => bridge?.platform === 'darwin' && bridge.isFullScreen?.() === true;

/** 全屏进入和退出完成后再同步，避免把最大化误当成全屏。 */
export function useMacFullscreen() {
	const [fullscreen, setFullscreen] = useState(readFullscreen);
	useEffect(() => {
		return bridge?.onMaximizeChange?.(() => setFullscreen(readFullscreen()));
	}, []);
	return fullscreen;
}
