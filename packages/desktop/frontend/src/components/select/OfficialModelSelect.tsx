import {Check, ChevronDown} from 'lucide-react';

import {EffortSlider} from './EffortSlider';
import {Popover, PopoverContent, PopoverTrigger} from '@/components/ui/popover';
import {ProviderIcon} from '@/components/ui/provider-icon';
import {useTranslation} from '@/i18n/useI18n';
import {TOCHAT_MODELS, modelAvailable, toChatModel, type ToChatModelId, type ToChatModelAvailability} from '@/lib/tochatModels';

export function OfficialModelSelect({model, effort, models, disabled, onModel, onEffort, className = ''}: {
 model: ToChatModelId; effort: string; models?: ToChatModelAvailability[]; disabled?: boolean;
 onModel: (id: ToChatModelId) => void; onEffort: (level: string) => void; className?: string;
}) {
 const {t} = useTranslation(), selected = toChatModel(model);
 const provider = model.startsWith('gpt') ? 'openai' : model.startsWith('claude') ? 'anthropic' : model.startsWith('gemini') ? 'gemini' : 'deepseek';
 return <Popover><PopoverTrigger disabled={disabled} aria-label={t('llm-select.placeholder')} className={`inline-flex min-w-0 items-center gap-1.5 rounded-full px-2 py-1 text-sm hover:bg-muted ${className}`}>
  <ProviderIcon keyName={provider} size="size-4" /><span className="web-model-name truncate">{selected.name}</span><span className="shrink-0 text-muted-foreground">{t(`llm-select.level.${effort}`)}</span><ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
 </PopoverTrigger><PopoverContent align="end" sideOffset={8} className="w-72 gap-0 max-w-[calc(100vw-24px)] max-h-[var(--radix-popover-content-available-height)] overflow-y-auto rounded-2xl p-2">
  <p className="px-3 py-2 text-sm font-medium text-muted-foreground">{t('llm-select.placeholder')}</p>
  <div className="px-3 pb-2 pt-1"><p className="text-sm font-medium">{t('llm-select.defaultSet')}</p><p className="text-xs text-muted-foreground">{t('llm-select.recommendedSet')}</p></div>
  <div role="group" aria-label={t('llm-select.placeholder')}>{TOCHAT_MODELS.map(item => <button type="button" key={item.id} disabled={disabled || !modelAvailable(item.id,models)} aria-pressed={model===item.id} onClick={() => onModel(item.id)} className="flex w-full items-center justify-between gap-3 rounded-xl px-3 py-2.5 text-start text-sm hover:bg-accent disabled:opacity-40"><span>{item.name}</span>{model===item.id && <Check className="size-4 text-muted-foreground" />}</button>)}</div>
  <div className="mt-2 border-t"><EffortSlider levels={selected.efforts} value={effort} model={selected.name} disabled={disabled} onChange={onEffort} /></div>
 </PopoverContent></Popover>;
}
