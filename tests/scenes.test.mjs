import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_SCENES, resolvedSceneSlots, sceneById, CANVAS_W, CANVAS_H, containFit, drawPlaceholder, SceneCompositor } from '../dist/scenes.js';

function fakeCtx() {
  const calls = [];
  return {
    calls,
    clearRect(...args) { calls.push({ op: 'clearRect', args }); },
    fillRect(...args) { calls.push({ op: 'fillRect', args }); },
    drawImage(...args) { calls.push({ op: 'drawImage', args }); },
    fillText(...args) { calls.push({ op: 'fillText', args }); },
    set fillStyle(v) { calls.push({ op: 'fillStyle', value: v }); },
    set font(v) { calls.push({ op: 'font', value: v }); },
    set textAlign(v) { calls.push({ op: 'textAlign', value: v }); },
    set textBaseline(v) { calls.push({ op: 'textBaseline', value: v }); },
  };
}

function fakeDrawable(w, h) {
  return { width: w, height: h };
}

test('DEFAULT_SCENES has exactly ten entries', () => {
  assert.equal(DEFAULT_SCENES.length, 10);
});

test('sceneById returns correct scene', () => {
  assert.equal(sceneById('1cam').id, '1cam');
  assert.equal(sceneById('screensharevert-8').id, 'screensharevert-8');
  assert.throws(() => sceneById('nonexistent'));
});

test('all ten backgrounds have unique asset filenames', () => {
  const assets = DEFAULT_SCENES.map(s => s.asset);
  assert.equal(new Set(assets).size, 10);
});

test('all slots stay inside the 1920×1080 canvas', () => {
  for (const scene of DEFAULT_SCENES) {
    for (const slot of scene.slots) {
      const { x, y, w, h } = slot.rect;
      assert.ok(x >= 0, `${scene.id} slot ${slot.index} x=${x} < 0`);
      assert.ok(y >= 0, `${scene.id} slot ${slot.index} y=${y} < 0`);
      assert.ok(x + w <= CANVAS_W, `${scene.id} slot ${slot.index} right edge ${x + w} > ${CANVAS_W}`);
      assert.ok(y + h <= CANVAS_H, `${scene.id} slot ${slot.index} bottom edge ${y + h} > ${CANVAS_H}`);
    }
  }
});

test('containFit returns placeholder dimensions if source is invalid', () => {
  const fit = containFit(0, 0, { x: 10, y: 20, w: 300, h: 200 });
  assert.equal(fit.dx, 10);
  assert.equal(fit.dy, 20);
  assert.equal(fit.dw, 300);
  assert.equal(fit.dh, 200);
});

test('composeFrame draws opaque base, sources, then overlay last', async () => {
  const ctx = fakeCtx();
  const bg = fakeDrawable(1920, 1080);
  const source = { kind: 'camera', index: 0, state: 'live', drawable: fakeDrawable(1280, 720), naturalWidth: 1280, naturalHeight: 720 };
  const compositor = new SceneCompositor();
  const gen = await compositor.composeFrame(ctx, { scene: sceneById('1cam'), resolveAsset: async () => bg, sources: [source] });
  assert.ok(gen > 0);
  const drawImages = ctx.calls.filter(c => c.op === 'drawImage');
  assert.ok(drawImages.length === 2, 'should draw source then background overlay');
  assert.equal(drawImages[1].args[0], bg, 'background overlay must be drawn last');
});

test('composeFrame handles invalid source dimensions gracefully', async () => {
  const ctx = fakeCtx();
  const bg = fakeDrawable(1920, 1080);
  const source = { kind: 'camera', index: 0, state: 'live', drawable: fakeDrawable(0, 0), naturalWidth: 0, naturalHeight: 0 };
  const compositor = new SceneCompositor();
  await compositor.composeFrame(ctx, { scene: sceneById('1cam'), resolveAsset: async () => bg, sources: [source] });
  const drawImages = ctx.calls.filter(c => c.op === 'drawImage');
  assert.ok(drawImages.length === 1, 'should draw background overlay only'); // The source is drawn as placeholder
  const texts = ctx.calls.filter(c => c.op === 'fillText');
  assert.ok(texts.some(t => t.args[0] === 'Camera 1'));
});

test('composeFrame race: newer call invalidates older', async () => {
  const ctx = fakeCtx();
  const bg = fakeDrawable(1920, 1080);
  let resolveFirst;
  const slowAsset = new Promise(resolve => { resolveFirst = resolve; });
  const compositor = new SceneCompositor();
  
  const first = compositor.composeFrame(ctx, { scene: sceneById('1cam'), resolveAsset: () => slowAsset, sources: [] });
  const second = compositor.composeFrame(ctx, { scene: sceneById('2cam'), resolveAsset: async () => bg, sources: [] });
  
  const gen2 = await second;
  resolveFirst(bg);
  const gen1 = await first;
  
  assert.ok(gen1 < gen2, 'first compose should have lower generation');
  const drawImages = ctx.calls.filter(c => c.op === 'drawImage');
  assert.ok(drawImages.length === 1); // Only the second drew the background overlay
});

test('composeFrame invalidation: invalidate cancels pending render', async () => {
  const ctx = fakeCtx();
  const bg = fakeDrawable(1920, 1080);
  let resolveAsset;
  const slowAsset = new Promise(resolve => { resolveAsset = resolve; });
  const compositor = new SceneCompositor();
  
  const pending = compositor.composeFrame(ctx, { scene: sceneById('1cam'), resolveAsset: () => slowAsset, sources: [] });
  compositor.invalidate();
  resolveAsset(bg);
  
  await pending;
  const drawImages = ctx.calls.filter(c => c.op === 'drawImage');
  assert.ok(drawImages.length === 0, 'invalidated render should not draw anything');
});

test('per-context races: concurrent two-context renders both complete', async () => {
  const ctx1 = fakeCtx();
  const ctx2 = fakeCtx();
  const bg = fakeDrawable(1920, 1080);
  
  const comp1 = new SceneCompositor();
  const comp2 = new SceneCompositor();
  
  const p1 = comp1.composeFrame(ctx1, { scene: sceneById('1cam'), resolveAsset: async () => bg, sources: [] });
  const p2 = comp2.composeFrame(ctx2, { scene: sceneById('2cam'), resolveAsset: async () => bg, sources: [] });
  
  await Promise.all([p1, p2]);
  
  assert.ok(ctx1.calls.filter(c => c.op === 'drawImage').length === 1);
  assert.ok(ctx2.calls.filter(c => c.op === 'drawImage').length === 1);
});


// CodexBWAI: occupied screen-share strips stay centred without fixed-frame ghosts.
const participants = indices => indices.map(index => ({ kind: 'camera', index, state: 'muted', drawable: null, naturalWidth: 0, naturalHeight: 0 }));
for (const id of ['screensharevert-8', 'screensharehorizont-8']) {
  for (const count of [0, 1, 2, 3, 8]) {
    test(`${id}: ${count} occupied camera frames centre within the strip`, () => {
      const scene = sceneById(id);
      const slots = resolvedSceneSlots(scene, participants(Array.from({ length: count }, (_, index) => index)));
      assert.equal(slots.filter(slot => slot.kind === 'screenshare').length, 1);
      const cameras = slots.filter(slot => slot.kind === 'camera');
      assert.equal(cameras.length, count);
      if (!count) return;
      const vertical = id === 'screensharevert-8';
      const axis = vertical ? 'y' : 'x'; const extent = vertical ? 'h' : 'w';
      const first = cameras[0].rect; const last = cameras.at(-1).rect;
      assert.equal((first[axis] + last[axis] + last[extent]) / 2, vertical ? 590 : 960);
      for (let i = 0; i < cameras.length; i++) {
        const rect = cameras[i].rect;
        assert.ok(rect.x >= 0 && rect.y >= 0 && rect.x + rect.w <= 1920 && rect.y + rect.h <= 1080);
        if (i) assert.equal(rect[axis] - cameras[i - 1].rect[axis] - cameras[i - 1].rect[extent], 12);
      }
      if (count === 8 && !vertical) assert.deepEqual(cameras, scene.slots.filter(slot => slot.kind === 'camera'));
    });
  }
  test(`${id}: sparse identity mapping includes paused cameras, excludes empty and caps capacity`, () => {
    const sources = [...participants([7, 2, 2, 0, 8, -1]), { ...participants([5])[0], state: 'empty' }];
    const slots = resolvedSceneSlots(sceneById(id), sources).filter(slot => slot.kind === 'camera');
    assert.deepEqual(slots.map(slot => slot.index), [0, 2, 7]);
  });
  test(`${id}: draw only occupied frames and crop the old fixed-frame overlay away`, async () => {
    const ctx = fakeCtx(); const overlay = fakeDrawable(1920, 1080);
    await new SceneCompositor().composeFrame(ctx, { scene: sceneById(id), sources: participants([0, 3, 7]), resolveAsset: async () => overlay });
    const images = ctx.calls.filter(call => call.op === 'drawImage');
    assert.deepEqual(images.map(call => call.args), [[overlay, 0, 0, 1920, 100, 0, 0, 1920, 100]]);
    const labels = ctx.calls.filter(call => call.op === 'fillText').map(call => call.args[0]);
    assert.equal(labels.filter(label => label === 'Camera paused').length, 3);
    assert.ok(labels.includes('No screen shared'));
  });
}
test('camera-only scenes retain their exact shipped geometry and default slots', () => {
  for (const scene of DEFAULT_SCENES.filter(scene => !scene.hasScreenshare)) {
    assert.equal(resolvedSceneSlots(scene, []), scene.slots);
    assert.equal(resolvedSceneSlots(scene, participants([7])), scene.slots);
  }
});

for (const id of ['screensharevert-8', 'screensharehorizont-8']) {
  test(`${id}: fewer attendees grow camera images without stretching or overlapping the screen`, () => {
    let previousArea = Infinity;
    for (let count = 1; count <= 8; count++) {
      const slots = resolvedSceneSlots(sceneById(id), participants(Array.from({ length: count }, (_, i) => i)));
      const screen = slots.find(slot => slot.kind === 'screenshare').rect;
      const cameras = slots.filter(slot => slot.kind === 'camera');
      const area = cameras[0].rect.w * cameras[0].rect.h;
      assert.ok(area <= previousArea + 0.001); previousArea = area;
      for (const { rect } of cameras) {
        assert.ok(Math.abs(rect.w / rect.h - 16 / 9) < 1e-10);
        assert.ok(rect.x >= screen.x + screen.w + 12 || rect.y >= screen.y + screen.h + 12);
        const fit = containFit(1920, 1080, rect);
        assert.ok(Math.abs(fit.dw - rect.w) < 1e-9 && Math.abs(fit.dh - rect.h) < 1e-9);
      }
    }
    const one = resolvedSceneSlots(sceneById(id), participants([0])).find(slot => slot.kind === 'camera').rect;
    const eight = resolvedSceneSlots(sceneById(id), participants([0,1,2,3,4,5,6,7])).find(slot => slot.kind === 'camera').rect;
    assert.ok(one.w > eight.w && one.h > eight.h);
  });
}
