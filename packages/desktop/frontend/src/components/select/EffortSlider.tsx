import { RotateCcw, Zap } from 'lucide-react';

import { useTranslation } from '@/i18n/useI18n';
import './effort-slider.css';

/** Native range keeps keyboard, touch and screen-reader behaviour in sync. */
export function EffortSlider({levels, value, model, onChange, disabled = false}: {
 levels: readonly string[]; value: string; model: string; onChange: (level: string) => void; disabled?: boolean;
}) {
 const {t} = useTranslation();
 const index = Math.max(0, levels.indexOf(value));
 const label = (level: string) => t(`llm-select.level.${level}`);
 return <div className="space-y-3 px-2 py-3" data-testid="effort-slider">
  <div className="flex items-start justify-between gap-3">
   <Zap className="mt-0.5 size-4 text-muted-foreground" aria-hidden="true" />
   <div className="min-w-0 text-center"><p className="font-medium text-blue-500" aria-live="polite">{label(levels[index])}</p><p className="mt-0.5 truncate text-xs text-muted-foreground">{model}</p></div>
   <button type="button" aria-label={t('llm-select.resetThinking')} disabled={disabled} className="rounded-md p-0.5 text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-40" onClick={() => onChange(levels.includes('high') ? 'high' : levels[0])}><RotateCcw className="size-4" /></button>
  </div>
  <div className="tora-effort-track">
   <div className="tora-effort-fill" style={{width: `${levels.length > 1 ? index / (levels.length - 1) * 100 : 0}%`}} />
   <div className="tora-effort-dots" aria-hidden="true">{levels.map(level => <span key={level} />)}</div>
   <input type="range" min={0} max={levels.length - 1} step={1} value={index} disabled={disabled || levels.length < 2} aria-label={t('llm-select.thinking')} aria-valuetext={label(levels[index])} onChange={event => onChange(levels[Number(event.target.value)])} />
  </div>
 </div>;
}
