// 各模型服务商品牌图标（本地打包，无运行时外链）
// 来源：simpleicons.org（SVG）+ 各官网 favicon/logo（PNG/ICO）
// StepFun: Lobe Icons (MIT)；OpenAI: 官方品牌包。
// Grok: Lobe Icons (MIT).
import gemini from '@/assets/providers/lobe-gemini-color.svg';
import grok from '@/assets/providers/lobe-grok.svg';
import stepfun from '@/assets/providers/lobe-stepfun.svg';
import openai from '@/assets/providers/openai-black-monoblossom.svg';
// Gemini: Lobe Icons (MIT)；Anthropic: Simple Icons (CC0)。
import alibabacloud from '@/assets/providers/si-alibabacloud.svg';
import anthropic from '@/assets/providers/si-anthropic.svg';
import deepseek from '@/assets/providers/si-deepseek.svg';
import kimi from '@/assets/providers/si-kimi.svg';
import minimax from '@/assets/providers/si-minimax.svg';
import ollama from '@/assets/providers/si-ollama.svg';
import openrouter from '@/assets/providers/si-openrouter.svg';
import xiaomi from '@/assets/providers/si-xiaomi.svg';
import apiyi from '@/assets/providers/site-apiyi.png';
import bigmodel from '@/assets/providers/site-bigmodel.png';
import byteplus from '@/assets/providers/site-byteplus.png';
import hunyuan from '@/assets/providers/site-hunyuan.png';
import ppio from '@/assets/providers/site-ppio.ico';
import shuliuyun from '@/assets/providers/site-shuliuyun.svg';
import siliconflow from '@/assets/providers/site-siliconflow.png';
import volcengine from '@/assets/providers/site-volcengine.png';
import zai from '@/assets/providers/site-zai.svg';

/** provider key → 图标资源；未列出的（如自定义）由调用方渲染兜底图标 */
export const PROVIDER_ICONS: Record<string, string> = {
	openai,
	xai: grok,
	grok,
	google: gemini,
	gemini,
	anthropic,
	deepseek,
	volcengine,
	'minimax-cn': minimax,
	'minimax-global': minimax,
	bigmodel,
	dashscope: alibabacloud,
	mimo: xiaomi,
	siliconflow,
	stepfun,
	'stepfun-global': stepfun,
	zai,
	openrouter,
	apiyi,
	shuliuyun,
	'kimi-cn': kimi,
	'kimi-global': kimi,
	byteplus,
	hunyuan,
	ppio,
	ollama,
};
