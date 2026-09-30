import { StrictMode, useEffect } from 'react';
import { createRoot } from 'react-dom/client';

import './index.css';
import './i18n';
import App from './App.tsx';
import { TooltipProvider } from '@/components/ui/tooltip.tsx';

function RemoveBootSplash() {
	useEffect(() => {
		const splash = document.getElementById('boot-splash');
		if (!splash) return;
		let frame = 0;
		let timer = 0;
		frame = requestAnimationFrame(() => {
			frame = requestAnimationFrame(() => {
				splash.classList.add('is-leaving');
				if (matchMedia('(prefers-reduced-motion: reduce)').matches) splash.remove();
				else timer = window.setTimeout(() => splash.remove(), 240);
			});
		});
		return () => {
			cancelAnimationFrame(frame);
			window.clearTimeout(timer);
		};
	}, []);
	return null;
}

createRoot(document.getElementById('root')!).render(
	<StrictMode>
		<TooltipProvider>
			<RemoveBootSplash />
			<App />
		</TooltipProvider>
	</StrictMode>,
);
