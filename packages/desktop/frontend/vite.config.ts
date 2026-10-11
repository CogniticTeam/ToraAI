import path from 'path';

import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import svgr from 'vite-plugin-svgr';

export default defineConfig({
	base:process.env.TORA_UI_BASE||'/',
	plugins: [react(), tailwindcss(), svgr(),{name:'tora-ui-release',transformIndexHtml(){return [{tag:'meta',attrs:{name:'tora-ui-version',content:process.env.TORA_UI_VERSION||'bundled'}},{tag:'meta',attrs:{name:'tora-ui-build',content:process.env.TORA_UI_BUILD||String(Date.now())}}];}}],
	server: {
		proxy: {
			'/api': 'http://localhost:3000',
		},
	},
	resolve: {
		alias: {
			'@': path.resolve(__dirname, './src'),
		},
	},
	optimizeDeps: {
		include: ['mime-types'],
	},
});
