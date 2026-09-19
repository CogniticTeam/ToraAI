// 模型服务商品牌图标：品牌图优先，未收录的 provider 由调用方传 fallback（lucide 图标）
import { PROVIDER_ICONS } from '@/lib/providerIcons';

export function ProviderIcon({
  keyName,
  size = 'size-7',
  fallback,
}: {
  keyName: string;
  size?: string;
  fallback?: React.ReactNode;
}) {
  const src = PROVIDER_ICONS[keyName];
  if (src) {
    return (
      <span className={`flex shrink-0 items-center justify-center overflow-hidden rounded-md border border-border bg-white ${size}`}>
        <img src={src} alt="" className="size-[72%] object-contain" draggable={false} />
      </span>
    );
  }
  return <>{fallback ?? null}</>;
}