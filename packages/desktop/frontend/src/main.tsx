import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import './index.css';
import App from './App.tsx';
import { initializeI18n } from './i18n';
import { BootSplashCleanup } from '@/components/auth/BootSplashCleanup';
import { TooltipProvider } from '@/components/ui/tooltip.tsx';

await initializeI18n();

createRoot(document.getElementById('root')!).render(
	<StrictMode>
		<TooltipProvider>
			<BootSplashCleanup />
			<App />
		</TooltipProvider>
	</StrictMode>,
);
