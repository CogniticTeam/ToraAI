// 桌面账户限制与强制更新共用的运行门槛；CLI 默认不启用。
const blocks = new Map();
export function setAccessBlock(source, message) {
  if (message) blocks.set(source, message); else blocks.delete(source);
}
export function accessBlockReason(exceptSource) { for(const [source,reason] of blocks)if(source!==exceptSource)return reason;return ''; }
