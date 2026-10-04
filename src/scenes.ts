// BCAST-14 scene compositor — Antigravity_CLI
// Geometry measured from PNG alpha channels. Independent per-context renderer.

export const CANVAS_W = 1920;
export const CANVAS_H = 1080;

export interface SlotRect {
  readonly x: number; readonly y: number; readonly w: number; readonly h: number;
}
export type SourceKind = 'camera' | 'screenshare';
export interface SceneSlot {
  readonly rect: SlotRect;
  readonly kind: SourceKind;
  readonly index: number;
}

export type SceneId = '1cam' | '2cam' | '3cam' | '4cam' | '5cam' | '6cam' | '7cam' | '8cam' | 'screensharevert-8' | 'screensharehorizont-8';

export interface SceneDefinition {
  readonly id: SceneId;
  readonly label: string;
  readonly asset: string;
  readonly cameraCount: number;
  readonly hasScreenshare: boolean;
  readonly slots: readonly SceneSlot[];
}

/** 'reconnecting' (ClaudeBWAI, 4 Oct): a guest's media path is recovering; the tile keeps its last frame, dimmed, with an amber badge. */
export type SourceState = 'live' | 'ended' | 'muted' | 'empty' | 'reconnecting';

export interface DrawableSource {
  readonly kind: SourceKind;
  readonly index: number;
  readonly state: SourceState;
  readonly drawable: CanvasImageSource | null;
  readonly naturalWidth: number;
  readonly naturalHeight: number;
}

function cam(x: number, y: number, w: number, h: number, index: number): SceneSlot {
  return Object.freeze({ rect: Object.freeze({ x, y, w, h }), kind: 'camera', index });
}
function screen(x: number, y: number, w: number, h: number): SceneSlot {
  return Object.freeze({ rect: Object.freeze({ x, y, w, h }), kind: 'screenshare', index: 0 });
}
function freezeScene(scene: Omit<SceneDefinition, 'slots'> & { slots: SceneSlot[] }): SceneDefinition {
  return Object.freeze({
    ...scene,
    slots: Object.freeze(scene.slots)
  });
}

// Alpha-derived bounding boxes
const SCENE_1CAM = freezeScene({
  id: '1cam', label: 'One camera', asset: '1cam.png', cameraCount: 1, hasScreenshare: false,
  slots: [cam(230, 172, 1461, 755, 0)]
});
const SCENE_2CAM = freezeScene({
  id: '2cam', label: 'Two cameras', asset: '2cam.png', cameraCount: 2, hasScreenshare: false,
  slots: [cam(80, 316, 848, 477, 0), cam(992, 316, 848, 477, 1)]
});
const SCENE_3CAM = freezeScene({
  id: '3cam', label: 'Three cameras', asset: '3cam.png', cameraCount: 3, hasScreenshare: false,
  slots: [cam(640, 156, 640, 360, 0), cam(288, 588, 640, 360, 1), cam(992, 588, 640, 360, 2)]
});
const SCENE_4CAM = freezeScene({
  id: '4cam', label: 'Four cameras', asset: '4cam.png', cameraCount: 4, hasScreenshare: false,
  slots: [cam(288, 156, 640, 360, 0), cam(992, 156, 640, 360, 1), cam(288, 588, 640, 360, 2), cam(992, 588, 640, 360, 3)]
});
const SCENE_5CAM = freezeScene({
  id: '5cam', label: 'Five cameras', asset: '5cam.png', cameraCount: 5, hasScreenshare: false,
  slots: [cam(368, 204, 560, 315, 0), cam(992, 204, 560, 315, 1), cam(56, 588, 560, 315, 2), cam(680, 588, 560, 315, 3), cam(1304, 588, 560, 315, 4)]
});
const SCENE_6CAM = freezeScene({
  id: '6cam', label: 'Six cameras', asset: '6cam.png', cameraCount: 6, hasScreenshare: false,
  slots: [cam(56, 204, 560, 315, 0), cam(680, 204, 560, 315, 1), cam(1304, 204, 560, 315, 2), cam(56, 588, 560, 315, 3), cam(680, 588, 560, 315, 4), cam(1304, 588, 560, 315, 5)]
});
const SCENE_7CAM = freezeScene({
  id: '7cam', label: 'Seven cameras', asset: '7cam.png', cameraCount: 7, hasScreenshare: false,
  slots: [cam(280, 280, 432, 243, 0), cam(744, 280, 432, 243, 1), cam(1208, 280, 432, 243, 2), cam(48, 586, 432, 243, 3), cam(512, 586, 432, 243, 4), cam(976, 586, 432, 243, 5), cam(1440, 586, 432, 243, 6)]
});
const SCENE_8CAM = freezeScene({
  id: '8cam', label: 'Eight cameras', asset: '8cam.png', cameraCount: 8, hasScreenshare: false,
  slots: [cam(48, 280, 432, 243, 0), cam(512, 280, 432, 243, 1), cam(976, 280, 432, 243, 2), cam(1440, 280, 432, 243, 3), cam(48, 586, 432, 243, 4), cam(512, 586, 432, 243, 5), cam(976, 586, 432, 243, 6), cam(1440, 586, 432, 243, 7)]
});
const SCENE_SS_VERT = freezeScene({
  id: 'screensharevert-8', label: 'Screenshare (vertical strip)', asset: 'screensharevert-8.png', cameraCount: 8, hasScreenshare: true,
  slots: [screen(16, 116, 1504, 948), cam(1552, 116, 352, 108, 0), cam(1552, 236, 352, 108, 1), cam(1552, 356, 352, 108, 2), cam(1552, 476, 352, 108, 3), cam(1552, 596, 352, 108, 4), cam(1552, 716, 352, 108, 5), cam(1552, 836, 352, 108, 6), cam(1552, 956, 352, 108, 7)]
});
const SCENE_SS_HORIZ = freezeScene({
  id: 'screensharehorizont-8', label: 'Screenshare (horizontal strip)', asset: 'screensharehorizont-8.png', cameraCount: 8, hasScreenshare: true,
  slots: [screen(16, 116, 1888, 800), cam(22, 938, 224, 126, 0), cam(258, 938, 224, 126, 1), cam(494, 938, 224, 126, 2), cam(730, 938, 224, 126, 3), cam(966, 938, 224, 126, 4), cam(1202, 938, 224, 126, 5), cam(1438, 938, 224, 126, 6), cam(1674, 938, 224, 126, 7)]
});

export const DEFAULT_SCENES: readonly SceneDefinition[] = Object.freeze([
  SCENE_1CAM, SCENE_2CAM, SCENE_3CAM, SCENE_4CAM, SCENE_5CAM, SCENE_6CAM, SCENE_7CAM, SCENE_8CAM, SCENE_SS_VERT, SCENE_SS_HORIZ
]);

export function sceneById(id: SceneId): SceneDefinition {
  const scene = DEFAULT_SCENES.find(s => s.id === id);
  if (!scene) throw new Error(`Unknown scene: ${id}`);
  return scene;
}

// CodexBWAI: share layouts use a continuous strip plus independently placed frames.
// Only participants present in the source list occupy a frame; paused cameras keep theirs.
export function resolvedSceneSlots(scene: SceneDefinition, sources: readonly DrawableSource[]): readonly SceneSlot[] {
  if (!scene.hasScreenshare) return scene.slots;
  const template = scene.slots.find(slot => slot.kind === 'camera')!;
  const cameraIndices = [...new Set(sources
    .filter(source => source.kind === 'camera' && source.state !== 'empty' && Number.isInteger(source.index) && source.index >= 0 && source.index < scene.cameraCount)
    .map(source => source.index))].sort((a, b) => a - b);
  const vertical = scene.id === 'screensharevert-8';
  const count = cameraIndices.length;
  const gapSpace = Math.max(0, count - 1) * 12;
  // Keep camera frames at 16:9. Smaller groups use the strip width instead of
  // retaining the eight-person slot's letterboxed image size.
  const width = !count ? template.rect.w : vertical
    ? Math.min(352, (948 - gapSpace) / count * 16 / 9)
    : Math.min(448, (1876 - gapSpace) / count);
  const height = width * 9 / 16;
  const extent = vertical ? height : width;
  const cameraY = vertical ? template.rect.y : 1064 - height;
  const screenSlot = scene.slots.find(slot => slot.kind === 'screenshare')!;
  const activeScreen = vertical || !count ? screenSlot : screen(16, 116, 1888, cameraY - 22 - 116);
  const center = vertical ? 590 : CANVAS_W / 2;
  const first = center - (cameraIndices.length * extent + Math.max(0, cameraIndices.length - 1) * 12) / 2;
  return [
    activeScreen,
    ...cameraIndices.map((index, position) => cam(
      vertical ? 1728 - width / 2 : first + position * (extent + 12),
      vertical ? first + position * (extent + 12) : cameraY,
      width, height, index,
    )),
  ];
}

function drawShareBackground(ctx: CanvasRenderingContext2D, scene: SceneDefinition, header: CanvasImageSource, slots: readonly SceneSlot[]): void {
  // Retain the supplied brand header only. The fixed eight-frame portion is never drawn.
  ctx.drawImage(header, 0, 0, CANVAS_W, 100, 0, 0, CANVAS_W, 100);
  ctx.fillStyle = PLACEHOLDER_BG;
  if (scene.id === 'screensharevert-8') ctx.fillRect(1544, 108, 368, 964);
  else {
    const top = (slots.find(slot => slot.kind === 'camera')?.rect.y ?? 938) - 8;
    ctx.fillRect(16, top, 1888, 1072 - top);
  }
  ctx.fillStyle = '#ffab01';
  for (const { rect } of slots) ctx.fillRect(rect.x - 3, rect.y - 3, rect.w + 6, rect.h + 6);
}

export interface FitResult {
  readonly sx: number; readonly sy: number; readonly sw: number; readonly sh: number;
  readonly dx: number; readonly dy: number; readonly dw: number; readonly dh: number;
}
export function containFit(srcW: number, srcH: number, slot: SlotRect): FitResult {
  if (!isFinite(srcW) || srcW <= 0 || !isFinite(srcH) || srcH <= 0) {
    return { sx: 0, sy: 0, sw: 1, sh: 1, dx: slot.x, dy: slot.y, dw: slot.w, dh: slot.h };
  }
  const srcAR = srcW / srcH;
  const slotAR = slot.w / slot.h;
  let dw: number, dh: number;
  if (srcAR > slotAR) {
    dw = slot.w;
    dh = slot.w / srcAR;
  } else {
    dh = slot.h;
    dw = slot.h * srcAR;
  }
  const dx = slot.x + (slot.w - dw) / 2;
  const dy = slot.y + (slot.h - dh) / 2;
  return { sx: 0, sy: 0, sw: srcW, sh: srcH, dx, dy, dw, dh };
}

const PLACEHOLDER_BG = '#1a1a1a';
const PLACEHOLDER_FG = '#666666';
const OPAQUE_BASE = '#232323';

export function drawPlaceholder(ctx: CanvasRenderingContext2D, slot: SceneSlot, state: SourceState): void {
  const { x, y, w, h } = slot.rect;
  ctx.fillStyle = PLACEHOLDER_BG;
  ctx.fillRect(x, y, w, h);
  const label = state === 'ended' ? 'Disconnected' :
    state === 'muted' ? 'Camera paused' :
    slot.kind === 'screenshare' ? 'No screen shared' : `Camera ${slot.index + 1}`;
  const fontSize = Math.max(12, Math.min(24, Math.floor(h / 8)));
  ctx.font = `${fontSize}px sans-serif`;
  ctx.fillStyle = PLACEHOLDER_FG;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(label, x + w / 2, y + h / 2, w - 16);
}

/** Dims the last frame and adds a small amber 'Reconnecting…' badge in the slot's top-left corner. */
export function drawReconnectingOverlay(ctx: CanvasRenderingContext2D, slot: SceneSlot): void {
  const { x, y, w, h } = slot.rect;
  ctx.fillStyle = 'rgba(0,0,0,0.55)';
  ctx.fillRect(x, y, w, h);
  const fontSize = Math.max(11, Math.min(20, Math.floor(h / 14)));
  ctx.font = `600 ${fontSize}px sans-serif`;
  const text = 'Reconnecting…';
  const bw = Math.min(w - 8, ctx.measureText(text).width + fontSize), bh = fontSize * 1.7;
  ctx.fillStyle = '#ffab01';
  ctx.fillRect(x + 8, y + 8, bw, bh);
  ctx.fillStyle = '#232323'; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
  ctx.fillText(text, x + 8 + fontSize / 2, y + 8 + bh / 2, bw - fontSize);
}

export type AssetResolver = (filename: string) => Promise<CanvasImageSource>;

export interface CompositorOptions {
  readonly scene: SceneDefinition;
  readonly customBackdrop?: boolean;
  readonly resolveAsset: AssetResolver;
  readonly sources: readonly DrawableSource[];
}

export class SceneCompositor {
  private generation = 0;

  /** Cancels any pending render operations on this compositor instance. */
  invalidate(): void {
    this.generation++;
  }

  async composeFrame(ctx: CanvasRenderingContext2D, options: CompositorOptions): Promise<number> {
    const gen = ++this.generation;
    const { scene, resolveAsset, sources } = options;
    const overlay = await resolveAsset(scene.asset);
    if (gen !== this.generation) return gen;

    // Draw opaque base (behind sources)
    ctx.clearRect(0, 0, CANVAS_W, CANVAS_H);
    ctx.fillStyle = OPAQUE_BASE;
    ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);

    const slots = resolvedSceneSlots(scene, sources);
    if (scene.hasScreenshare) {
      if(options.customBackdrop) {
        ctx.drawImage(overlay,0,0,CANVAS_W,CANVAS_H);
        ctx.fillStyle='#ffab01'; for(const {rect} of slots) ctx.fillRect(rect.x-3,rect.y-3,rect.w+6,rect.h+6);
      }
      else drawShareBackground(ctx, scene, overlay, slots);
    }

    // Draw sources and placeholders
    for (const slot of slots) {
      const source = sources.find(s => s.kind === slot.kind && s.index === slot.index);
      if (!source || source.state === 'empty' || source.state === 'ended' || !source.drawable) {
        drawPlaceholder(ctx, slot, source?.state ?? 'empty');
        continue;
      }
      if (source.state === 'muted') {
        drawPlaceholder(ctx, slot, 'muted');
        continue;
      }
      
      const { naturalWidth, naturalHeight } = source;
      if (!isFinite(naturalWidth) || naturalWidth <= 0 || !isFinite(naturalHeight) || naturalHeight <= 0) {
        drawPlaceholder(ctx, slot, 'empty');
        continue;
      }

      const fit = containFit(naturalWidth, naturalHeight, slot.rect);
      ctx.fillStyle = PLACEHOLDER_BG;
      ctx.fillRect(slot.rect.x, slot.rect.y, slot.rect.w, slot.rect.h);
      ctx.drawImage(source.drawable, fit.sx, fit.sy, fit.sw, fit.sh, fit.dx, fit.dy, fit.dw, fit.dh);
      if (source.state === 'reconnecting') drawReconnectingOverlay(ctx, slot);
    }

    // Draw transparent background over the top to preserve branding and anti-aliased borders
    if (!scene.hasScreenshare) ctx.drawImage(overlay, 0, 0, CANVAS_W, CANVAS_H);

    return gen;
  }
}
