/** One canvas, bounded pixel sampling, no per-grain DOM nodes. */
export const SAND_SWEEP_MS = 800;
export const SAND_LIFE_MS = 1000;
export const SAND_COUNT = 1500;
export type SandGrain = { x: number; y: number; color: string; alpha: number; delay: number; size: number; dx: number; dy: number; phase: number };

export function sampleSand(data: Uint8ClampedArray, width: number, height: number, cssWidth: number, cssHeight: number, random = Math.random): SandGrain[] {
 const pixels: number[] = [];
 const stride = Math.max(1, Math.ceil(Math.sqrt(width * height / 60_000)));
 for (let y = 0; y < height; y += stride) for (let x = 0; x < width; x += stride) {
  const offset = (y * width + x) * 4;
  if (data[offset + 3] > 12) pixels.push(offset);
 }
 if (!pixels.length) return [];
 const left = Math.min(...pixels.map(offset => offset / 4 % width));
 const right = Math.max(...pixels.map(offset => offset / 4 % width));
 return Array.from({length: SAND_COUNT}, (_, i) => {
  // Stratify across the whole visible surface instead of clustering at random.
  const offset = pixels[Math.min(pixels.length - 1, Math.floor((i + random()) / SAND_COUNT * pixels.length))];
  const pixel = offset / 4, x = (pixel % width + .5) / width * cssWidth, y = (Math.floor(pixel / width) + .5) / height * cssHeight;
  return {x, y, color: `rgb(${data[offset]},${data[offset + 1]},${data[offset + 2]})`, alpha: data[offset + 3] / 255,
   delay: Math.max(0, (pixel % width - left) / Math.max(1, right - left)) * SAND_SWEEP_MS, size: 1.3 + random() * 2, dx: 70 + random() * 120, dy: 45 + random() * 100, phase: random() * Math.PI * 2};
 });
}

export function sandPose(grain: SandGrain, elapsed: number) {
 const age = (elapsed - grain.delay) / SAND_LIFE_MS;
 if (age < 0 || age >= 1) return null;
 return {x: grain.x + grain.dx * age + Math.sin(age * 19 + grain.phase) * 4 * age,
  y: grain.y - grain.dy * age + Math.sin(age * 23 + grain.phase) * 3 * age,
  size: grain.size * (1 - age), alpha: grain.alpha * (1 - age) ** 1.5};
}

export function messageMotionEnabled() {
 if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return false;
 try {return localStorage.getItem('tora.motion.mode') !== 'off';} catch {return true;}
}

/** The source is erased in place; only the moving grains live on the overlay. */
export async function dissolveMessage(source: HTMLElement, signal: AbortSignal) {
 if (signal.aborted || !messageMotionEnabled()) return;
 const initial = source.getBoundingClientRect();
 if (!initial.width || !initial.height) return;
 let snapshot: HTMLCanvasElement | null = null;
 let timeout: ReturnType<typeof setTimeout> | undefined;
 try {
  snapshot = await Promise.race([
   import('html-to-image').then(({toCanvas}) => toCanvas(source, {
    pixelRatio: Math.min(1, Math.sqrt(2_000_000 / (initial.width * initial.height)), 8192 / initial.height, 8192 / initial.width), skipFonts: true, includeQueryParams:true,
    filter: node => !(node instanceof HTMLElement && node.dataset.slot === 'message-footer'),
   })),
   new Promise<null>(resolve => {timeout = setTimeout(() => resolve(null), 2000);}),
  ]);
 } catch { /* Unsupported media must not prevent an already saved deletion. */ }
 finally {clearTimeout(timeout);}
 if (signal.aborted || !source.isConnected) return;
 const canvas = document.createElement('canvas'), ctx = canvas.getContext('2d');
 if (!ctx) return;
 const paddingTop = 160, paddingRight = 220;
 const renderScale = Math.min(1, Math.sqrt(2_000_000 / ((initial.width + paddingRight) * (initial.height + paddingTop))), 8192 / (initial.height + paddingTop));
 canvas.width = Math.ceil((initial.width + paddingRight) * renderScale); canvas.height = Math.ceil((initial.height + paddingTop) * renderScale);
 canvas.dataset.messageSand = 'true'; canvas.setAttribute('aria-hidden', 'true');
 Object.assign(canvas.style, {position:'fixed', pointerEvents:'none', zIndex:'60', width:`${initial.width + paddingRight}px`, height:`${initial.height + paddingTop}px`});
 ctx.scale(renderScale, renderScale);
 let grains: SandGrain[] = [];
 if (snapshot) {
  try {const pixels = snapshot.getContext('2d')!.getImageData(0, 0, snapshot.width, snapshot.height);
   grains = sampleSand(pixels.data, pixels.width, pixels.height, initial.width, initial.height);
  } catch { /* Tainted canvases fall back to the same progressive wipe. */ }
  snapshot.width = snapshot.height = 0;
 }
 const oldClip = source.style.clipPath;
 const sweepLeft = grains.length ? Math.min(...grains.map(grain => grain.x)) : 0;
 const sweepRight = grains.length ? Math.max(...grains.map(grain => grain.x)) + 2 : initial.width;
 const footers = Array.from(source.querySelectorAll<HTMLElement>('[data-slot="message-footer"]')).map(node => ({node, visibility:node.style.visibility}));
 footers.forEach(({node}) => {node.style.visibility = 'hidden';});
 document.body.append(canvas);
 await new Promise<void>(resolve => {
  let frame = 0, start: number | undefined;
  const finish = () => {
   cancelAnimationFrame(frame); signal.removeEventListener('abort', finish); canvas.remove();
   source.style.clipPath = oldClip; footers.forEach(({node, visibility}) => {node.style.visibility = visibility;}); resolve();
  };
  signal.addEventListener('abort', finish, {once:true});
  const draw = (now: number) => {
   if (signal.aborted || !source.isConnected) {finish(); return;}
   start ??= now; const elapsed = now - start;
   const rect = source.getBoundingClientRect();
   canvas.style.left = `${rect.left}px`; canvas.style.top = `${rect.top - paddingTop}px`;
   const sweep = Math.min(1, elapsed / SAND_SWEEP_MS);
   source.style.clipPath = `inset(0 0 0 ${sweep === 1 ? 100 : (sweepLeft + (sweepRight - sweepLeft) * sweep) / initial.width * 100}%)`;
   ctx.clearRect(0, 0, initial.width + paddingRight, initial.height + paddingTop);
   for (const grain of grains) {
    const pose = sandPose(grain, elapsed); if (!pose) continue;
    ctx.globalAlpha = pose.alpha; ctx.fillStyle = grain.color;
    ctx.fillRect(pose.x, pose.y + paddingTop, pose.size, pose.size);
   }
   if (elapsed >= SAND_SWEEP_MS + SAND_LIFE_MS) {finish(); return;}
   frame = requestAnimationFrame(draw);
  };
  frame = requestAnimationFrame(draw);
 });
}
