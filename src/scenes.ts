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

// ClaudeBWAI — einh 4 Oct (CP4c): one layout, two painters. layoutFrame is the single place the geometry and the
// per-source decisions are made; the Canvas 2D painter and the WebGL2 painter both walk the same op list.
const AMBER = '#ffab01';
const DIM = 'rgba(0,0,0,0.55)';
export const HEADER_H = 100;

export type FrameOp =
  | { readonly op: 'clear' }
  | { readonly op: 'rect'; readonly rect: SlotRect; readonly color: string }
  | { readonly op: 'header' }
  | { readonly op: 'backdrop' }
  | { readonly op: 'overlay' }
  | { readonly op: 'video'; readonly slot: SceneSlot; readonly source: DrawableSource; readonly fit: FitResult }
  | { readonly op: 'placeholder'; readonly slot: SceneSlot; readonly state: SourceState; readonly label: string; readonly fontSize: number }
  | { readonly op: 'reconnecting'; readonly slot: SceneSlot; readonly dim: SlotRect; readonly badge: SlotRect; readonly text: string; readonly fontSize: number };

export interface FrameLayout {
  /** Target canvas size; the ops are always in the 1920x1080 scene space and the painter scales. */
  readonly width: number;
  readonly height: number;
  readonly ops: readonly FrameOp[];
}
export interface LayoutOptions {
  readonly customBackdrop?: boolean;
  /** Width of `text` in `fontSize` semibold px; the 2D path passes the real canvas measure. */
  readonly measure?: (text: string, fontSize: number) => number;
}

export function placeholderLabel(slot: SceneSlot, state: SourceState): string {
  return state === 'ended' ? 'Disconnected' :
    state === 'muted' ? 'Camera paused' :
    slot.kind === 'screenshare' ? 'No screen shared' : `Camera ${slot.index + 1}`;
}
export function placeholderFontSize(h: number): number { return Math.max(12, Math.min(24, Math.floor(h / 8))); }
const RECONNECT_TEXT = 'Reconnecting…';
export function reconnectFontSize(h: number): number { return Math.max(11, Math.min(20, Math.floor(h / 14))); }
const estimateWidth = (text: string, fontSize: number): number => text.length * fontSize * 0.55;

export function layoutFrame(scene: SceneDefinition, sources: readonly DrawableSource[], width: number, height: number, options: LayoutOptions = {}): FrameLayout {
  const measure = options.measure ?? estimateWidth;
  const ops: FrameOp[] = [];
  const full: SlotRect = { x: 0, y: 0, w: CANVAS_W, h: CANVAS_H };
  ops.push({ op: 'clear' }, { op: 'rect', rect: full, color: OPAQUE_BASE });

  const slots = resolvedSceneSlots(scene, sources);
  if (scene.hasScreenshare) {
    if (options.customBackdrop) ops.push({ op: 'backdrop' });
    else {
      // Retain the supplied brand header only. The fixed eight-frame portion is never drawn.
      ops.push({ op: 'header' });
      if (scene.id === 'screensharevert-8') ops.push({ op: 'rect', rect: { x: 1544, y: 108, w: 368, h: 964 }, color: PLACEHOLDER_BG });
      else {
        const top = (slots.find(slot => slot.kind === 'camera')?.rect.y ?? 938) - 8;
        ops.push({ op: 'rect', rect: { x: 16, y: top, w: 1888, h: 1072 - top }, color: PLACEHOLDER_BG });
      }
    }
    for (const { rect } of slots) ops.push({ op: 'rect', rect: { x: rect.x - 3, y: rect.y - 3, w: rect.w + 6, h: rect.h + 6 }, color: AMBER });
  }

  const placeholder = (slot: SceneSlot, state: SourceState): void => {
    ops.push({ op: 'placeholder', slot, state, label: placeholderLabel(slot, state), fontSize: placeholderFontSize(slot.rect.h) });
  };
  for (const slot of slots) {
    const source = sources.find(s => s.kind === slot.kind && s.index === slot.index);
    if (!source || source.state === 'empty' || source.state === 'ended' || !source.drawable) { placeholder(slot, source?.state ?? 'empty'); continue; }
    if (source.state === 'muted') { placeholder(slot, 'muted'); continue; }
    const { naturalWidth, naturalHeight } = source;
    if (!isFinite(naturalWidth) || naturalWidth <= 0 || !isFinite(naturalHeight) || naturalHeight <= 0) { placeholder(slot, 'empty'); continue; }
    ops.push({ op: 'rect', rect: slot.rect, color: PLACEHOLDER_BG });
    ops.push({ op: 'video', slot, source, fit: containFit(naturalWidth, naturalHeight, slot.rect) });
    if (source.state === 'reconnecting') {
      const { x, y, w, h } = slot.rect;
      const fontSize = reconnectFontSize(h);
      const bw = Math.min(w - 8, measure(RECONNECT_TEXT, fontSize) + fontSize), bh = fontSize * 1.7;
      ops.push({ op: 'reconnecting', slot, dim: slot.rect, badge: { x: x + 8, y: y + 8, w: bw, h: bh }, text: RECONNECT_TEXT, fontSize });
    }
  }
  // Transparent background over the top to preserve branding and anti-aliased borders
  if (!scene.hasScreenshare) ops.push({ op: 'overlay' });
  return { width, height, ops };
}

/** Paints a layout with Canvas 2D. Call order is the historical composeFrame order. */
export function paintLayout2d(ctx: CanvasRenderingContext2D, layout: FrameLayout, overlay: CanvasImageSource): void {
  let fill: string | null = null;
  const setFill = (c: string): void => { if (fill !== c) { ctx.fillStyle = c; fill = c; } };
  for (const op of layout.ops) {
    switch (op.op) {
      case 'clear': ctx.clearRect(0, 0, CANVAS_W, CANVAS_H); break;
      case 'rect': setFill(op.color); ctx.fillRect(op.rect.x, op.rect.y, op.rect.w, op.rect.h); break;
      case 'header': ctx.drawImage(overlay, 0, 0, CANVAS_W, HEADER_H, 0, 0, CANVAS_W, HEADER_H); break;
      case 'backdrop': case 'overlay': ctx.drawImage(overlay, 0, 0, CANVAS_W, CANVAS_H); break;
      case 'video': { const f = op.fit; ctx.drawImage(op.source.drawable as CanvasImageSource, f.sx, f.sy, f.sw, f.sh, f.dx, f.dy, f.dw, f.dh); break; }
      case 'placeholder': drawPlaceholder(ctx, op.slot, op.state); fill = null; break;
      case 'reconnecting': drawReconnectingOverlay(ctx, op.slot); fill = null; break;
    }
  }
}

export interface FrameDrawOptions {
  /** The scene's PNG (resolved by the caller); drawn as header, backdrop or top overlay. */
  readonly overlay?: CanvasImageSource | null;
  readonly customBackdrop?: boolean;
}
/** The one interface the studio draws through; Canvas 2D and WebGL2 both implement it. */
export interface FrameCompositor {
  readonly backend: 'canvas2d' | 'webgl2';
  draw(scene: SceneDefinition, sources: readonly DrawableSource[], width: number, height: number, options?: FrameDrawOptions): void;
  resize(width: number, height: number): void;
  lost(): boolean;
  rebuild(): void;
  dispose(): void;
}

export function createCanvas2dCompositor(canvas: HTMLCanvasElement | OffscreenCanvas): FrameCompositor | null {
  const ctx = canvas.getContext('2d') as CanvasRenderingContext2D | null;
  if (!ctx) return null;
  return {
    backend: 'canvas2d',
    draw(scene, sources, width, height, options = {}) {
      const layout = layoutFrame(scene, sources, width, height, {
        customBackdrop: options.customBackdrop,
        measure: (text, fontSize) => { ctx.font = `600 ${fontSize}px sans-serif`; return ctx.measureText(text).width; },
      });
      const scaled = width !== CANVAS_W || height !== CANVAS_H;
      if (scaled) { ctx.save(); ctx.scale(width / CANVAS_W, height / CANVAS_H); }
      paintLayout2d(ctx, layout, (options.overlay ?? null) as CanvasImageSource);
      if (scaled) ctx.restore();
    },
    resize(width, height) { canvas.width = width; canvas.height = height; },
    lost() { return false; },
    rebuild() { /* nothing to rebuild */ },
    dispose() { /* nothing held */ },
  };
}

// ---- WebGL2 backend -------------------------------------------------------------------------------------------

const VERT = `#version 300 es
uniform vec4 uRect; uniform vec4 uSrc; uniform vec2 uScene;
out vec2 vUv;
void main() {
  vec2 c = vec2(float(gl_VertexID & 1), float((gl_VertexID >> 1) & 1));
  vec2 p = uRect.xy + c * uRect.zw;
  gl_Position = vec4(p.x / uScene.x * 2.0 - 1.0, 1.0 - p.y / uScene.y * 2.0, 0.0, 1.0);
  vUv = mix(uSrc.xy, uSrc.zw, c);
}`;
const FRAG = `#version 300 es
precision mediump float;
uniform sampler2D uTex; uniform vec4 uColor; uniform float uUseTex;
in vec2 vUv; out vec4 o;
void main() { o = uUseTex > 0.5 ? texture(uTex, vUv) : vec4(uColor.rgb * uColor.a, uColor.a); }`;

/** '#rrggbb' or 'rgba(r,g,b,a)' to 0..1 floats. */
export function parseCssColor(css: string): [number, number, number, number] {
  if (css[0] === '#') { const n = parseInt(css.slice(1), 16); return [(n >> 16 & 255) / 255, (n >> 8 & 255) / 255, (n & 255) / 255, 1]; }
  const m = /rgba?\(([^)]+)\)/.exec(css);
  const v = (m?.[1] ?? '0,0,0,1').split(',').map(Number);
  return [(v[0] ?? 0) / 255, (v[1] ?? 0) / 255, (v[2] ?? 0) / 255, v[3] ?? 1];
}

export interface GlCompositorOptions {
  /** Test seam: where text/badge bitmaps are drawn before upload. Defaults to OffscreenCanvas or a DOM canvas. */
  readonly createTextCanvas?: (width: number, height: number) => HTMLCanvasElement | OffscreenCanvas;
}

export function createGlCompositor(canvas: HTMLCanvasElement | OffscreenCanvas, options: GlCompositorOptions = {}): FrameCompositor | null {
  let gl: WebGL2RenderingContext | null = null;
  try { gl = canvas.getContext('webgl2', { alpha: false, antialias: false, premultipliedAlpha: true }) as WebGL2RenderingContext | null; } catch { gl = null; }
  if (!gl) return null;
  const g: WebGL2RenderingContext = gl;
  const makeText = options.createTextCanvas ?? ((w: number, h: number) => {
    if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h);
    const c = document.createElement('canvas'); c.width = w; c.height = h; return c;
  });

  let contextLost = false;
  let program: WebGLProgram | null = null;
  let loc: Record<'rect' | 'src' | 'scene' | 'tex' | 'color' | 'useTex', WebGLUniformLocation | null> = { rect: null, src: null, scene: null, tex: null, color: null, useTex: null };
  let videoTex = new Map<string, WebGLTexture>();
  let textTex = new Map<string, WebGLTexture>();
  // ClaudeBWAI — einh 5 Oct: only the overlay being drawn keeps a texture; a replaced image's texture is freed at once.
  let overlayTex = new Map<object, WebGLTexture>();
  let measureCtx: CanvasRenderingContext2D | null = null;

  const onLost = (e: Event): void => { e.preventDefault?.(); contextLost = true; };
  const onRestored = (): void => { contextLost = false; };
  (canvas as HTMLCanvasElement).addEventListener?.('webglcontextlost', onLost);
  (canvas as HTMLCanvasElement).addEventListener?.('webglcontextrestored', onRestored);

  function compile(type: number, src: string): WebGLShader {
    const sh = g.createShader(type)!;
    g.shaderSource(sh, src); g.compileShader(sh);
    return sh;
  }
  function build(): void {
    program = g.createProgram()!;
    g.attachShader(program, compile(g.VERTEX_SHADER, VERT));
    g.attachShader(program, compile(g.FRAGMENT_SHADER, FRAG));
    g.linkProgram(program);
    g.useProgram(program);
    loc = {
      rect: g.getUniformLocation(program, 'uRect'), src: g.getUniformLocation(program, 'uSrc'), scene: g.getUniformLocation(program, 'uScene'),
      tex: g.getUniformLocation(program, 'uTex'), color: g.getUniformLocation(program, 'uColor'), useTex: g.getUniformLocation(program, 'uUseTex'),
    };
    g.uniform1i(loc.tex, 0);
    g.uniform2f(loc.scene, CANVAS_W, CANVAS_H);
    g.enable(g.BLEND);
    g.blendFunc(g.ONE, g.ONE_MINUS_SRC_ALPHA);
    g.pixelStorei(g.UNPACK_PREMULTIPLY_ALPHA_WEBGL, 1);
  }
  function newTexture(): WebGLTexture {
    const t = g.createTexture()!;
    g.bindTexture(g.TEXTURE_2D, t);
    g.texParameteri(g.TEXTURE_2D, g.TEXTURE_MIN_FILTER, g.LINEAR);
    g.texParameteri(g.TEXTURE_2D, g.TEXTURE_MAG_FILTER, g.LINEAR);
    g.texParameteri(g.TEXTURE_2D, g.TEXTURE_WRAP_S, g.CLAMP_TO_EDGE);
    g.texParameteri(g.TEXTURE_2D, g.TEXTURE_WRAP_T, g.CLAMP_TO_EDGE);
    return t;
  }
  function upload(t: WebGLTexture, image: TexImageSource): void {
    g.bindTexture(g.TEXTURE_2D, t);
    g.texImage2D(g.TEXTURE_2D, 0, g.RGBA, g.RGBA, g.UNSIGNED_BYTE, image);
  }
  function quadSolid(r: SlotRect, color: string): void {
    const c = parseCssColor(color);
    g.uniform1f(loc.useTex, 0);
    g.uniform4f(loc.color, c[0], c[1], c[2], c[3]);
    g.uniform4f(loc.rect, r.x, r.y, r.w, r.h);
    g.drawArrays(g.TRIANGLE_STRIP, 0, 4);
  }
  function quadTex(t: WebGLTexture, r: SlotRect, src: [number, number, number, number] = [0, 0, 1, 1]): void {
    g.bindTexture(g.TEXTURE_2D, t);
    g.uniform1f(loc.useTex, 1);
    g.uniform4f(loc.src, src[0], src[1], src[2], src[3]);
    g.uniform4f(loc.rect, r.x, r.y, r.w, r.h);
    g.drawArrays(g.TRIANGLE_STRIP, 0, 4);
  }
  /** Text lives in a small 2D bitmap uploaded once per content key; later frames only draw the cached texture. */
  function textTexture(key: string, w: number, h: number, paint: (ctx: CanvasRenderingContext2D) => void, used: Set<string>): WebGLTexture {
    used.add(key);
    let t = textTex.get(key);
    if (!t) {
      const c = makeText(Math.max(1, Math.ceil(w)), Math.max(1, Math.ceil(h)));
      const ctx = c.getContext('2d') as CanvasRenderingContext2D;
      paint(ctx);
      t = newTexture();
      upload(t, c as TexImageSource);
      textTex.set(key, t);
    }
    return t;
  }
  function measure(text: string, fontSize: number): number {
    if (!measureCtx) measureCtx = (makeText(1, 1).getContext('2d') as CanvasRenderingContext2D | null);
    if (!measureCtx) return estimateWidth(text, fontSize);
    measureCtx.font = `600 ${fontSize}px sans-serif`;
    return measureCtx.measureText(text).width;
  }

  build();

  return {
    backend: 'webgl2',
    draw(scene, sources, width, height, drawOptions = {}) {
      if (contextLost || g.isContextLost()) return;
      const layout = layoutFrame(scene, sources, width, height, { customBackdrop: drawOptions.customBackdrop, measure });
      const overlay = drawOptions.overlay as object | null | undefined;
      let overlayT: WebGLTexture | null = null;
      for (const [k, t] of overlayTex) if (k !== overlay) { g.deleteTexture(t); overlayTex.delete(k); }
      if (overlay) {
        overlayT = overlayTex.get(overlay) ?? null;
        if (!overlayT) { overlayT = newTexture(); upload(overlayT, overlay as TexImageSource); overlayTex.set(overlay, overlayT); }
      }
      // ClaudeBWAI — einh 5 Oct: layout is in 1920x1080 scene space (uScene); the viewport must cover the whole buffer so the scene scales to any output size.
      g.viewport(0, 0, g.drawingBufferWidth || canvas.width || width, g.drawingBufferHeight || canvas.height || height);
      g.useProgram(program);
      const used = new Set<string>();
      const usedVideo = new Set<string>();
      for (const op of layout.ops) {
        switch (op.op) {
          case 'clear': g.clearColor(0, 0, 0, 0); g.clear(g.COLOR_BUFFER_BIT); break;
          case 'rect': quadSolid(op.rect, op.color); break;
          case 'header': if (overlayT) quadTex(overlayT, { x: 0, y: 0, w: CANVAS_W, h: HEADER_H }, [0, 0, 1, HEADER_H / CANVAS_H]); break;
          case 'backdrop': case 'overlay': if (overlayT) quadTex(overlayT, { x: 0, y: 0, w: CANVAS_W, h: CANVAS_H }); break;
          case 'video': {
            const key = `${op.slot.kind}:${op.slot.index}`;
            usedVideo.add(key);
            let t = videoTex.get(key);
            if (!t) { t = newTexture(); videoTex.set(key, t); }
            upload(t, op.source.drawable as TexImageSource);
            quadTex(t, { x: op.fit.dx, y: op.fit.dy, w: op.fit.dw, h: op.fit.dh });
            break;
          }
          case 'placeholder': {
            const { w, h } = op.slot.rect;
            const key = `ph|${op.label}|${op.fontSize}|${w}|${h}`;
            const t = textTexture(key, w, h, ctx => drawPlaceholder(ctx, { rect: { x: 0, y: 0, w, h }, kind: op.slot.kind, index: op.slot.index }, op.state), used);
            quadTex(t, op.slot.rect);
            break;
          }
          case 'reconnecting': {
            quadSolid(op.dim, DIM);
            const { w, h } = op.badge;
            const key = `bd|${op.text}|${op.fontSize}|${w}|${h}`;
            const t = textTexture(key, w, h, ctx => {
              ctx.fillStyle = AMBER; ctx.fillRect(0, 0, w, h);
              ctx.font = `600 ${op.fontSize}px sans-serif`;
              ctx.fillStyle = OPAQUE_BASE; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
              ctx.fillText(op.text, op.fontSize / 2, h / 2, w - op.fontSize);
            }, used);
            quadTex(t, op.badge);
            break;
          }
        }
      }
      // Free what this frame did not use: stale text bitmaps and the textures of sources that left the scene.
      for (const [k, t] of textTex) if (!used.has(k)) { g.deleteTexture(t); textTex.delete(k); }
      for (const [k, t] of videoTex) if (!usedVideo.has(k)) { g.deleteTexture(t); videoTex.delete(k); }
    },
    resize(width, height) { canvas.width = width; canvas.height = height; if (!contextLost) g.viewport(0, 0, g.drawingBufferWidth || width, g.drawingBufferHeight || height); },
    lost() { return contextLost || g.isContextLost(); },
    rebuild() {
      // Every GL object died with the context: forget the handles and build again.
      videoTex = new Map(); textTex = new Map(); overlayTex = new Map();
      build();
      contextLost = false;
    },
    dispose() {
      (canvas as HTMLCanvasElement).removeEventListener?.('webglcontextlost', onLost);
      (canvas as HTMLCanvasElement).removeEventListener?.('webglcontextrestored', onRestored);
      for (const t of videoTex.values()) g.deleteTexture(t);
      for (const t of textTex.values()) g.deleteTexture(t);
      videoTex.clear(); textTex.clear();
      if (program) g.deleteProgram(program);
      program = null;
    },
  };
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
    paintLayout2d(ctx, layoutFrame(scene, sources, CANVAS_W, CANVAS_H, { customBackdrop: options.customBackdrop }), overlay);
    return gen;
  }

  /** Same staleness guard as composeFrame, painting through any FrameCompositor (Canvas 2D or WebGL2). */
  async composeWith(compositor: FrameCompositor, options: CompositorOptions, width = CANVAS_W, height = CANVAS_H): Promise<number> {
    const gen = ++this.generation;
    const { scene, resolveAsset, sources } = options;
    const overlay = await resolveAsset(scene.asset);
    if (gen !== this.generation) return gen;
    compositor.draw(scene, sources, width, height, { overlay, customBackdrop: options.customBackdrop });
    return gen;
  }
}

// ClaudeBWAI — einh 4 Oct (CP4c-2): what the studio does when the GPU drops the WebGL2 context. Between recordings the caller
// falls back to Canvas 2D at once; during a recording the context gets graceMs to come back (then rebuild()), else the
// recording is failed loudly rather than left as a frozen file. Pure of the DOM so a fake target and fake timers can drive it.
export interface GlContextWatchHooks {
  recording(): boolean;
  event(reason: 'context-lost' | 'context-restored'): void;
  /** Lost while no recording runs (or the recording ended meanwhile): fall back to Canvas 2D. */
  onLostIdle(): void;
  /** Lost during a recording and not back within graceMs (or rebuild failed): fail the recording. */
  onLostTimeout(): void;
}
export interface GlContextWatchTimers {
  readonly graceMs?: number;
  readonly setTimer?: (fn: () => void, ms: number) => unknown;
  readonly clearTimer?: (handle: unknown) => void;
}
export const GL_RESTORE_GRACE_MS = 5000;
export function watchGlContext(target: Pick<EventTarget, 'addEventListener' | 'removeEventListener'>, compositor: Pick<FrameCompositor, 'rebuild'>,
  hooks: GlContextWatchHooks, timers: GlContextWatchTimers = {}): { dispose(): void; pending(): boolean } {
  const graceMs = timers.graceMs ?? GL_RESTORE_GRACE_MS;
  const setTimer = timers.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = timers.clearTimer ?? (h => clearTimeout(h as ReturnType<typeof setTimeout>));
  let handle: unknown = null;
  const clear = (): void => { if (handle !== null) { clearTimer(handle); handle = null; } };
  const onLost = (e: Event): void => {
    e.preventDefault?.();
    hooks.event('context-lost');
    if (!hooks.recording()) { clear(); hooks.onLostIdle(); return; }
    clear();
    handle = setTimer(() => { handle = null; if (hooks.recording()) hooks.onLostTimeout(); else hooks.onLostIdle(); }, graceMs);
  };
  const onRestored = (): void => {
    clear();
    try { compositor.rebuild(); hooks.event('context-restored'); }
    catch { if (hooks.recording()) hooks.onLostTimeout(); else hooks.onLostIdle(); }
  };
  target.addEventListener('webglcontextlost', onLost as EventListener);
  target.addEventListener('webglcontextrestored', onRestored as EventListener);
  return {
    dispose() { clear(); target.removeEventListener('webglcontextlost', onLost as EventListener); target.removeEventListener('webglcontextrestored', onRestored as EventListener); },
    pending() { return handle !== null; },
  };
}
