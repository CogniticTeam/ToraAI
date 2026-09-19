// 各模型服务商品牌图标（本地打包，无运行时外链）
// 来源：simpleicons.org（SVG）+ 各官网 favicon/logo（PNG/ICO）
import alibabacloud from '@/assets/providers/si-alibabacloud.svg';
import deepseek from '@/assets/providers/si-deepseek.svg';
import kimi from '@/assets/providers/si-kimi.svg';
import minimax from '@/assets/providers/si-minimax.svg';
import ollama from '@/assets/providers/si-ollama.svg';
import openrouter from '@/assets/providers/si-openrouter.svg';
import xiaomi from '@/assets/providers/si-xiaomi.svg';
import bigmodel from '@/assets/providers/site-bigmodel.png';
import byteplus from '@/assets/providers/site-byteplus.png';
import hunyuan from '@/assets/providers/site-hunyuan.png';
import ppio from '@/assets/providers/site-ppio.ico';
import siliconflow from '@/assets/providers/site-siliconflow.png';
import volcengine from '@/assets/providers/site-volcengine.png';
import zai from '@/assets/providers/site-zai.svg';

/** provider key → 图标资源；未列出的（如自定义）由调用方渲染兜底图标 */
export const PROVIDER_ICONS: Record<string, string> = {
	deepseek,
	volcengine,
	'minimax-cn': minimax,
	'minimax-global': minimax,
	bigmodel,
	dashscope: alibabacloud,
	mimo: xiaomi,
	siliconflow,
	zai,
	openrouter,
	'kimi-cn': kimi,
	'kimi-global': kimi,
	byteplus,
	hunyuan,
	ppio,
	ollama,
};
