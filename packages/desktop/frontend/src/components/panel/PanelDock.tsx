import {AnimatePresence,motion,useIsPresent} from 'framer-motion';
import { Fragment, lazy, Suspense, useState, type ReactNode } from 'react';

import {
	ResizableHandle,
	ResizablePanel,
} from '@/components/ui/resizable.tsx';
import {useMotionSettings} from '@/hooks/useMotionSettings';
import { useTranslation } from '@/i18n/useI18n';
import { nextPanelAfterClose } from '@/lib/panelTabs';

/**
 * Identifier for a dockable panel. Used both as the React key and to
 * look its descriptor up in {@link PanelDockProps.panels}.
 */
export type PanelKey =
	| 'plan'
	| 'mcp'
	| 'skill'
	| 'permission'
	| 'knowledge'
	| 'team'
	// Tora 独有：改动前快照 / 未提交改动 / 项目钩子
	| 'checkpoint'
	| 'diff'
	| 'hooks'
	// 内置浏览器（Agent 的 Browser 工具也落在同一个视图里）
	| 'browser'
	// 内置终端（$SHELL -i：SSE 下行 + POST 上行）
	| 'terminal';

/**
 * The presentation of a single panel: header chrome plus its already
 * data-bound content node. Built by the owner (ChatViewport) so that
 * the dock itself stays free of any business/data dependency.
 */
export interface PanelDescriptor {
	/** Header title shown in the panel's chrome. */
	title: ReactNode;
	/** Plain localized name for the tab and close control. */
	tabLabel?: string;
	/** Optional leading icon shown next to the title. */
	icon?: ReactNode;
	/**
	 * Optional header-bar actions rendered to the left of the close
	 * button — typically `<Button variant="ghost" size="icon-sm">` items
	 * that open popovers / dropdowns (e.g. a parameters popover that
	 * would otherwise crowd the panel body).
	 */
	actions?: ReactNode;
	/**
	 * The panel body. Constructed by the owner with live data
	 * (e.g. `<TaskPanel tasksContext={...} />`) so it always reflects
	 * the latest state on every owner re-render.
	 */
	content: ReactNode;
}

interface PanelDockProps {
	layout: PanelKey[][];
	panels: Partial<Record<PanelKey, PanelDescriptor>>;
	onClosePanel: (key: PanelKey) => void;
	onOpenPanel?: (key: PanelKey) => void;
	onCloseDock?: () => void;
	activePanel?: PanelKey | null;
	onActivePanelChange?: (key: PanelKey | null) => void;
}

function DockMotion({mode,duration,children}:{mode:string;duration:number;children:ReactNode}) {
	const present=useIsPresent();
	return <motion.div data-dock-motion={mode} data-dock-exiting={!present} className={`flex h-full min-h-0 min-w-0 flex-col ${present?'':'pointer-events-none'}`} initial={{opacity:mode==='off'?1:0,x:mode==='off'?0:18}} animate={{opacity:1,x:0}} exit={{opacity:0,x:mode==='off'?0:18}} transition={{duration,ease:[0.2,0.7,0.2,1]}}>{children}</motion.div>;
}

const BuiltinBrowser = lazy(async () => ({default:(await import('./BrowserPanel')).BrowserPanel}));
const TOOL_MENU: PanelKey[] = ['plan','skill','diff','checkpoint','hooks','terminal'];

/** The browser owns the only tab strip for both web pages and tools. */
export const PanelDock = ({ layout, panels, onClosePanel, onOpenPanel, onCloseDock, activePanel, onActivePanelChange }: PanelDockProps) => {
	const { t } = useTranslation();
	const [selected, setSelected] = useState<PanelKey | null>(null);
	const keys = [...new Set(layout.flat())].filter(key => key !== 'browser' && panels[key]);
	const preferred = activePanel === undefined ? selected : activePanel;
	const active = preferred && keys.includes(preferred) ? preferred : null;
	const select = (key: PanelKey | null) => {setSelected(key);onActivePanelChange?.(key ?? 'browser');};
	const close = (key: PanelKey) => {select(nextPanelAfterClose(keys, active, key));onClosePanel(key);};
	const {effective,clickEnabled}=useMotionSettings();
	const motionMode=clickEnabled?effective:'off';
	const duration=motionMode==='off'?0:motionMode==='fast'?0.15:motionMode==='gentle'?0.3:0.22;
	return <AnimatePresence initial={false}>
		{layout.flat().length > 0 && <Fragment key="tool-dock">
			<ResizableHandle withHandle className="w-1.5 bg-transparent" />
			<ResizablePanel id="tool-dock" minSize="20rem" defaultSize="26rem" className="min-w-0">
				<DockMotion mode={motionMode} duration={duration}>
					<Suspense fallback={<div role="status" className="p-4 text-sm text-muted-foreground">{t('common.loading')}</div>}>
						<BuiltinBrowser toolTabs={keys.map(key => ({key,...panels[key]!}))} activeTool={active} onSelectTool={select} onCloseTool={close}
							availableTools={TOOL_MENU.filter(key => panels[key]).map(key => ({key,...panels[key]!}))} onOpenTool={key => {onOpenPanel?.(key);select(key);}}
							onClose={onCloseDock ?? (() => onClosePanel('browser'))} />
					</Suspense>
				</DockMotion>
			</ResizablePanel>
		</Fragment>}
	</AnimatePresence>;
};
