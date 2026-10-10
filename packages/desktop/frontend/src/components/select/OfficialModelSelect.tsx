import {ChevronDown} from 'lucide-react';

import GeminiLogo from '@/assets/providers/lobe-gemini-color.svg?react';
import GrokLogo from '@/assets/providers/lobe-grok.svg?react';
import OpenAILogo from '@/assets/providers/openai-black-monoblossom.svg?react';
import AnthropicLogo from '@/assets/providers/si-anthropic.svg?react';
import DeepSeekLogo from '@/assets/providers/si-deepseek.svg?react';
import BigmodelLogo from '@/assets/providers/site-bigmodel.png';
import VolcengineLogo from '@/assets/providers/site-volcengine.png';
import {DropdownMenu, DropdownMenuContent, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuSeparator, DropdownMenuTrigger} from '@/components/ui/dropdown-menu';
import {Tooltip,TooltipContent,TooltipTrigger} from '@/components/ui/tooltip';
import {useTranslation} from '@/i18n/useI18n';
import {TOCHAT_MODELS, modelAllowedInMode, modelAvailable, toChatModel, type ToChatModelId, type ToChatModelAvailability,type ModelTrial,type BuiltinQuota} from '@/lib/tochatModels';

function ModelIcon({model}: {model: string}) {
 if(model.startsWith('glm')) return <img src={BigmodelLogo} alt="" className="size-4 shrink-0" />;
 if(model.startsWith('grok')) return <GrokLogo className="size-4 shrink-0 dark:invert" />;
 if(model.startsWith('doubao')) return <img src={VolcengineLogo} alt="" className="size-4 shrink-0" />;
 if(model.startsWith('gemini')) return <GeminiLogo className="size-4 shrink-0" />;
 if(model.startsWith('claude')) return <AnthropicLogo className="size-4 shrink-0 dark:invert" />;
 if(model.startsWith('gpt')) return <OpenAILogo className="size-4 shrink-0 dark:invert" />;
 return <DeepSeekLogo data-testid="official-deepseek-logo" className="size-4 shrink-0" />;
}

/** Restore the original radio model menu, with the original thinking options. */
export function OfficialModelSelect({model, effort, models, trial, freeWorkQuota, subscribed = false, disabled, onModel, onEffort, className = '', mode = 'work'}: {
 mode?: 'chat' | 'work'; model: ToChatModelId; effort: string; models?: ToChatModelAvailability[]; trial?: ModelTrial; freeWorkQuota?: BuiltinQuota['doubaoWork']; subscribed?: boolean; disabled?: boolean;
 onModel: (id: ToChatModelId) => void; onEffort: (level: string) => void; className?: string;
}) {
 const {t} = useTranslation(), selected = toChatModel(model);
 return <DropdownMenu modal={false}><DropdownMenuTrigger disabled={disabled} aria-label={t('llm-select.placeholder')} className={`inline-flex min-w-0 items-center gap-1.5 rounded-full px-2 py-1 text-sm hover:bg-muted ${className}`}>
  <span aria-hidden="true"><ModelIcon model={model} /></span><span className="web-model-name truncate">{selected.name}</span><span className="shrink-0 text-muted-foreground">{t(`llm-select.level.${effort}`)}</span><ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
 </DropdownMenuTrigger><DropdownMenuContent align="end" className="official-model-menu min-w-60 max-w-[calc(100vw-24px)]">
  <DropdownMenuRadioGroup value={model} onValueChange={id => { if (!disabled && modelAllowedInMode(id,mode) && modelAvailable(id,models,mode)) onModel(id as ToChatModelId); }}>{TOCHAT_MODELS.filter(item => modelAllowedInMode(item.id,mode)).map(item => <DropdownMenuRadioItem key={item.id} value={item.id} className="data-disabled:pointer-events-auto data-disabled:cursor-not-allowed" disabled={disabled || !modelAvailable(item.id,models,mode)}><span aria-hidden="true"><ModelIcon model={item.id} /></span>{item.name}{item.id==='deepseek-flash'&&trial&&trial.remaining>0&&<span className="ms-auto text-xs text-muted-foreground">{t('llm-select.trialRemaining',{count:trial.remaining})}</span>}{item.id==='doubao-seed-2-1-lite-260915' && <Tooltip disableHoverableContent><TooltipTrigger asChild><span data-testid={mode==='work'&&subscribed?'doubao-credits-label':'doubao-free-label'} className="ms-auto cursor-help text-xs text-muted-foreground">{mode==='work'&&subscribed?t('llm-select.workCredits'):t('llm-select.freeChatModel')}</span></TooltipTrigger><TooltipContent side="top" align="end" sideOffset={6} collisionPadding={8} className="max-w-72 text-left leading-5">{mode==='work'?subscribed?t('llm-select.paidWorkModelHint'):t('llm-select.freeWorkModelHint',{remaining:freeWorkQuota?.canUse===false?0:freeWorkQuota?.remaining??10,total:freeWorkQuota?.total??10}):t('llm-select.freeChatModelHint')}</TooltipContent></Tooltip>}</DropdownMenuRadioItem>)}</DropdownMenuRadioGroup>
  <DropdownMenuSeparator /><DropdownMenuRadioGroup value={effort} onValueChange={onEffort}>{selected.efforts.map(level => <DropdownMenuRadioItem key={level} value={level} disabled={disabled}>{t(`llm-select.level.${level}`)}</DropdownMenuRadioItem>)}</DropdownMenuRadioGroup>
 </DropdownMenuContent></DropdownMenu>;
}
