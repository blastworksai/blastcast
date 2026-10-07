// ClaudeBWAI — einh 4 Oct (CP4c): the layout is shared; the 2D and WebGL2 backends must draw the same rects.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sceneById, layoutFrame, createGlCompositor, createCanvas2dCompositor, CANVAS_W, CANVAS_H } from '../dist/scenes.js';

const measureText = text => ({ width: text.length * 10 });
function fake2d() {
  const calls = [];
  const ctx = {
    calls, measureText,
    clearRect: (...a) => calls.push({ op: 'clearRect', a }), fillRect: (...a) => calls.push({ op: 'fillRect', a }),
    drawImage: (...a) => calls.push({ op: 'drawImage', a }), fillText: (...a) => calls.push({ op: 'fillText', a }),
    save() {}, restore() {}, scale() {},
  };
  for (const k of ['fillStyle', 'font', 'textAlign', 'textBaseline']) Object.defineProperty(ctx, k, { set(v) { calls.push({ op: k, v }); }, get() { return ''; } });
  return ctx;
}
const nat = { naturalWidth: 1280, naturalHeight: 720 };
const live = (kind, index, extra = {}) => ({ kind, index, state: 'live', drawable: { id: `${kind}${index}` }, ...nat, ...extra });
const overlay = { img: 'overlay' };
const scenes = {
  solo: ['1cam', [live('camera', 0)], {}],
  grid8: ['8cam', Array.from({ length: 8 }, (_, i) => live('camera', i)), {}],
  shareGuests: ['screensharehorizont-8', [live('screenshare', 0), live('camera', 0), live('camera', 1), live('camera', 2)], {}],
  shareSide: ['screensharevert-8', [live('screenshare', 0), live('camera', 0)], {}],
  backdrop: ['screensharehorizont-8', [live('screenshare', 0), live('camera', 0)], { customBackdrop: true }],
  overlayOnly: ['2cam', [live('camera', 0), live('camera', 1)], {}],
  mixed: ['4cam', [live('camera', 0), { kind: 'camera', index: 1, state: 'muted', drawable: null, ...nat }, live('camera', 2, { state: 'reconnecting' }), { kind: 'camera', index: 3, state: 'ended', drawable: null, ...nat }], {}],
};

function fakeGl() {
  const log = [];
  let u = null; const names = new Map(); let n = 0; let lostFlag = false;
  const gl = {
    log, canvasListeners: {},
    VERTEX_SHADER: 1, FRAGMENT_SHADER: 2, TEXTURE_2D: 3, RGBA: 4, UNSIGNED_BYTE: 5, TRIANGLE_STRIP: 6, BLEND: 7, ONE: 8, ONE_MINUS_SRC_ALPHA: 9,
    LINEAR: 10, CLAMP_TO_EDGE: 11, TEXTURE_MIN_FILTER: 12, TEXTURE_MAG_FILTER: 13, TEXTURE_WRAP_S: 14, TEXTURE_WRAP_T: 15, UNPACK_PREMULTIPLY_ALPHA_WEBGL: 16, COLOR_BUFFER_BIT: 17,
    createShader: () => ({}), shaderSource() {}, compileShader() {}, createProgram: () => ({}), attachShader() {}, linkProgram() {}, useProgram() {},
    getUniformLocation: (_p, name) => ({ name }), uniform1i() {}, uniform2f() {}, enable() {}, blendFunc() {}, pixelStorei() {}, clearColor() {}, clear() {},
    createTexture: () => ({ id: ++n }), bindTexture(_t, tex) { u = tex; }, texParameteri() {}, deleteTexture(t) { log.push({ op: 'deleteTexture', id: t.id }); }, deleteProgram() {},
    texImage2D(_t, _l, _i, _f, _ty, src) { log.push({ op: 'texImage2D', tex: u.id, src }); },
    viewport(...a) { log.push({ op: 'viewport', a }); },
    uniform1f(l, v) { log.push({ op: 'uniform1f', name: l.name, v }); },
    uniform4f(l, ...v) { log.push({ op: 'uniform4f', name: l.name, v }); },
    drawArrays(...a) { log.push({ op: 'drawArrays', a }); },
    isContextLost: () => lostFlag, setLost(v) { lostFlag = v; },
  };
  return gl;
}
function fakeCanvas(gl) {
  const listeners = {};
  return { width: 0, height: 0, listeners, getContext: k => (k === 'webgl2' ? gl : null),
    addEventListener(t, f) { listeners[t] = f; }, removeEventListener(t) { delete listeners[t]; } };
}
function textCanvasFactory(made) {
  return (w, h) => { const ctx = fake2d(); const c = { width: w, height: h, ctx, getContext: () => ctx }; made.push(c); return c; };
}
/** Draw rects the GL path issued: one per drawArrays, from the uRect uniform set before it. */
function glQuads(log) {
  const quads = []; let rect = null; let useTex = 0; let lastTex = null;
  for (const e of log) {
    if (e.op === 'uniform4f' && e.name === 'uRect') rect = e.v;
    if (e.op === 'uniform1f') useTex = e.v;
    if (e.op === 'drawArrays') quads.push({ rect, textured: useTex === 1 });
  }
  return quads;
}
/** What the layout says should be drawn as quads (clear is a glClear, not a quad). */
function expectedQuads(layout) {
  const out = [];
  for (const op of layout.ops) {
    if (op.op === 'clear') continue;
    if (op.op === 'rect') out.push({ rect: [op.rect.x, op.rect.y, op.rect.w, op.rect.h], textured: false });
    else if (op.op === 'header') out.push({ rect: [0, 0, CANVAS_W, 100], textured: true });
    else if (op.op === 'backdrop' || op.op === 'overlay') out.push({ rect: [0, 0, CANVAS_W, CANVAS_H], textured: true });
    else if (op.op === 'video') out.push({ rect: [op.fit.dx, op.fit.dy, op.fit.dw, op.fit.dh], textured: true });
    else if (op.op === 'placeholder') out.push({ rect: [op.slot.rect.x, op.slot.rect.y, op.slot.rect.w, op.slot.rect.h], textured: true });
    else if (op.op === 'reconnecting') {
      out.push({ rect: [op.dim.x, op.dim.y, op.dim.w, op.dim.h], textured: false });
      out.push({ rect: [op.badge.x, op.badge.y, op.badge.w, op.badge.h], textured: true });
    }
  }
  return out;
}

for (const [name, [id, sources, opts]] of Object.entries(scenes)) {
  test(`2D path draws exactly the layout rects: ${name}`, () => {
    const scene = sceneById(id);
    const ctx = fake2d();
    const comp = createCanvas2dCompositor({ getContext: () => ctx, width: 0, height: 0 });
    comp.draw(scene, sources, CANVAS_W, CANVAS_H, { overlay, ...opts });
    const layout = layoutFrame(scene, sources, CANVAS_W, CANVAS_H, { ...opts, measure: (t, fs) => measureText(t).width });
    const fills = ctx.calls.filter(c => c.op === 'fillRect').map(c => c.a);
    const wantFills = [];
    for (const op of layout.ops) {
      if (op.op === 'rect') wantFills.push([op.rect.x, op.rect.y, op.rect.w, op.rect.h]);
      if (op.op === 'placeholder') wantFills.push([op.slot.rect.x, op.slot.rect.y, op.slot.rect.w, op.slot.rect.h]);
      if (op.op === 'reconnecting') wantFills.push([op.dim.x, op.dim.y, op.dim.w, op.dim.h], [op.badge.x, op.badge.y, op.badge.w, op.badge.h]);
    }
    assert.deepEqual(fills, wantFills);
    const imgs = ctx.calls.filter(c => c.op === 'drawImage').map(c => c.a.slice(1));
    const wantImgs = [];
    for (const op of layout.ops) {
      if (op.op === 'header') wantImgs.push([0, 0, CANVAS_W, 100, 0, 0, CANVAS_W, 100]);
      if (op.op === 'backdrop' || op.op === 'overlay') wantImgs.push([0, 0, CANVAS_W, CANVAS_H]);
      if (op.op === 'video') wantImgs.push([op.fit.sx, op.fit.sy, op.fit.sw, op.fit.sh, op.fit.dx, op.fit.dy, op.fit.dw, op.fit.dh]);
    }
    assert.deepEqual(imgs, wantImgs);
  });

  test(`GL quads match layoutFrame (contract drift): ${name}`, () => {
    const scene = sceneById(id);
    const gl = fakeGl(); const made = [];
    const comp = createGlCompositor(fakeCanvas(gl), { createTextCanvas: textCanvasFactory(made) });
    assert.equal(comp.backend, 'webgl2');
    gl.log.length = 0;
    comp.draw(scene, sources, CANVAS_W, CANVAS_H, { overlay, ...opts });
    const layout = layoutFrame(scene, sources, CANVAS_W, CANVAS_H, { ...opts, measure: (t, fs) => measureText(t).width });
    assert.ok(gl.log.some(e => e.op === 'viewport' && e.a.join() === `0,0,${CANVAS_W},${CANVAS_H}`));
    const got = glQuads(gl.log), want = expectedQuads(layout);
    // The badge width comes from the GL path's own measure (the fake text canvas has none), so compare all but badge width.
    assert.equal(got.length, want.length);
    layout.ops.length; got.forEach((q, i) => {
      assert.equal(q.textured, want[i].textured);
      assert.deepEqual(q.rect.slice(0, 2), want[i].rect.slice(0, 2));
      if (q.rect[2] === want[i].rect[2]) assert.deepEqual(q.rect, want[i].rect);
    });
  });
}

test('GL uploads one texture per live video each frame, the overlay once', () => {
  const gl = fakeGl(); const scene = sceneById('2cam');
  const comp = createGlCompositor(fakeCanvas(gl), { createTextCanvas: textCanvasFactory([]) });
  const sources = scenes.overlayOnly[1];
  gl.log.length = 0;
  comp.draw(scene, sources, CANVAS_W, CANVAS_H, { overlay });
  comp.draw(scene, sources, CANVAS_W, CANVAS_H, { overlay });
  const ups = gl.log.filter(e => e.op === 'texImage2D');
  assert.equal(ups.filter(e => e.src === overlay).length, 1);
  assert.equal(ups.filter(e => e.src.id === 'camera0').length, 2);
});

test('text textures upload only when the content changes', () => {
  const gl = fakeGl(); const made = [];
  const comp = createGlCompositor(fakeCanvas(gl), { createTextCanvas: textCanvasFactory(made) });
  const scene = sceneById('2cam');
  const withState = state => [live('camera', 0), { kind: 'camera', index: 1, state, drawable: null, ...nat }];
  const textUploads = () => gl.log.filter(e => e.op === 'texImage2D' && e.src.ctx).length;
  gl.log.length = 0;
  comp.draw(scene, withState('empty'), CANVAS_W, CANVAS_H, { overlay });
  assert.equal(textUploads(), 1);
  comp.draw(scene, withState('empty'), CANVAS_W, CANVAS_H, { overlay });
  comp.draw(scene, withState('empty'), CANVAS_W, CANVAS_H, { overlay });
  assert.equal(textUploads(), 1, 'same content: no re-upload');
  comp.draw(scene, withState('ended'), CANVAS_W, CANVAS_H, { overlay });
  assert.equal(textUploads(), 2, 'new label: one upload');
  // the unused 'Camera 2' bitmap was freed
  assert.ok(gl.log.some(e => e.op === 'deleteTexture'));
});

test('createGlCompositor returns null without webgl2', () => {
  assert.equal(createGlCompositor({ getContext: () => null, addEventListener() {} }), null);
  assert.equal(createGlCompositor({ getContext() { throw new Error('no'); } }), null);
});

test('lost() follows the context and rebuild() clears it', () => {
  const gl = fakeGl(); const canvas = fakeCanvas(gl);
  const comp = createGlCompositor(canvas, { createTextCanvas: textCanvasFactory([]) });
  assert.equal(comp.lost(), false);
  canvas.listeners.webglcontextlost({ preventDefault() {} });
  assert.equal(comp.lost(), true);
  gl.log.length = 0;
  comp.draw(sceneById('1cam'), scenes.solo[1], CANVAS_W, CANVAS_H, { overlay });
  assert.equal(gl.log.filter(e => e.op === 'drawArrays').length, 0, 'a lost context draws nothing');
  comp.rebuild();
  assert.equal(comp.lost(), false);
  comp.draw(sceneById('1cam'), scenes.solo[1], CANVAS_W, CANVAS_H, { overlay });
  assert.ok(gl.log.some(e => e.op === 'drawArrays'));
  comp.dispose();
});

test('resize sets canvas size and viewport', () => {
  const gl = fakeGl(); const canvas = fakeCanvas(gl);
  const comp = createGlCompositor(canvas, { createTextCanvas: textCanvasFactory([]) });
  comp.resize(1280, 720);
  assert.equal(canvas.width, 1280);
  assert.deepEqual(gl.log.filter(e => e.op === 'viewport').at(-1).a, [0, 0, 1280, 720]);
});

// ClaudeBWAI — einh 5 Oct: the GL viewport covers the whole drawing buffer at any output size (scene stays 1920x1080).
for (const [w, h] of [[1920, 1080], [3840, 2160]]) {
  test(`GL viewport covers the ${w}x${h} drawing buffer while layout stays in scene space`, () => {
    const gl = fakeGl(); gl.drawingBufferWidth = w; gl.drawingBufferHeight = h;
    const canvas = fakeCanvas(gl);
    const comp = createGlCompositor(canvas, { createTextCanvas: textCanvasFactory([]) });
    comp.resize(w, h);
    gl.log.length = 0;
    comp.draw(sceneById('1cam'), [live('camera', 0)], CANVAS_W, CANVAS_H, { overlay });
    const vp = gl.log.filter(e => e.op === 'viewport').at(-1);
    assert.deepEqual(vp.a, [0, 0, w, h]);
    assert.ok(glQuads(gl.log).every(q => q.rect[0] + q.rect[2] <= CANVAS_W && q.rect[1] + q.rect[3] <= CANVAS_H));
  });
}
