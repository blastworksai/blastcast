// BCAST-14 scene-controls adapter — Antigravity_CLI
import type { SceneId, SceneDefinition, AssetResolver, DrawableSource, CompositorOptions } from './scenes.js';
import { DEFAULT_SCENES, sceneById, SceneCompositor, resolvedSceneSlots } from './scenes.js';

export interface SceneControlsOptions {
  readonly container: HTMLElement;
  readonly resolveAsset: AssetResolver;
  readonly onSceneSelected: (scene: SceneDefinition) => void;
  readonly customBackdrop?: (id: SceneId) => boolean;
  readonly brand?: { readonly primary?: string; readonly surface?: string; readonly text?: string; };
}

export interface SceneControlsHandle {
  readonly currentScene: SceneDefinition;
  selectScene(id: SceneId): void;
  updateSources(sources: readonly DrawableSource[]): void;
  composeToCanvas(ctx: CanvasRenderingContext2D): Promise<number>;
  destroy(): void;
}

export function mountSceneControls(options: SceneControlsOptions): SceneControlsHandle {
  const { container, resolveAsset, onSceneSelected } = options;
  const primary = options.brand?.primary ?? '#ffab01';
  const surface = options.brand?.surface ?? '#232323';
  const text = options.brand?.text ?? '#ffffff';

  let currentScene: SceneDefinition = DEFAULT_SCENES[0]!;
  let currentSources: readonly DrawableSource[] = [];
  let destroyed = false;
  let selectionGeneration = 0;

  const compositor = new SceneCompositor();

  const wrapper = document.createElement('div');
  wrapper.className = 'bcast-scene-controls';
  wrapper.setAttribute('role', 'radiogroup');
  wrapper.setAttribute('aria-label', 'Scene selection');

  const buttons: Map<SceneId, HTMLButtonElement> = new Map();

  for (const scene of DEFAULT_SCENES) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'bcast-scene-btn bc-scene';
    btn.setAttribute('role', 'radio');
    btn.setAttribute('aria-checked', String(scene.id === currentScene.id));
    btn.setAttribute('aria-label', scene.label);
    btn.title = scene.label;
    btn.dataset['sceneId'] = scene.id;

    // CodexBWAI — thumbnails use the same measured geometry as the live scene.
    const thumb = document.createElement('span');
    thumb.className = 'bc-scene__thumb'; thumb.setAttribute('aria-hidden', 'true');
    for (const slot of scene.slots) {
      const shape = document.createElement('i');
      if (slot.kind === 'screenshare') shape.className = 'is-share';
      shape.dataset.kind = slot.kind; shape.dataset.index = String(slot.index);
      shape.style.left = `${slot.rect.x / 1920 * 100}%`;
      shape.style.top = `${slot.rect.y / 1080 * 100}%`;
      shape.style.width = `${slot.rect.w / 1920 * 100}%`;
      shape.style.height = `${slot.rect.h / 1080 * 100}%`;
      thumb.append(shape);
    }
    const backdrop = document.createElement('img');
    backdrop.src = scene.asset; backdrop.alt = ''; if(!scene.hasScreenshare) thumb.append(backdrop);
    btn.append(thumb);
    const label = document.createElement('span');
    label.className = 'bcast-scene-label bc-scene__name';
    label.textContent = scene.hasScreenshare ? scene.id === 'screensharevert-8' ? 'Share, side' : 'Share, bottom' : `${scene.cameraCount} camera${scene.cameraCount === 1 ? '' : 's'}`;
    btn.appendChild(label);

    btn.addEventListener('click', () => { if (!destroyed) selectScene(scene.id); });
    btn.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        if (!destroyed) selectScene(scene.id);
      }
    });

    buttons.set(scene.id, btn);
    wrapper.appendChild(btn);
  }
  container.appendChild(wrapper);

  function updateButtonStates(): void {
    for (const [id, btn] of buttons) {
      const active = id === currentScene.id;
      btn.setAttribute('aria-checked', String(active));
    }
  }

  function selectScene(id: SceneId): void {
    if (destroyed) return;
    const scene = sceneById(id);
    const gen = ++selectionGeneration;
    compositor.invalidate();
    currentScene = scene;
    updateButtonStates();
    if (gen === selectionGeneration) onSceneSelected(scene);
  }

  async function composeToCanvas(ctx: CanvasRenderingContext2D): Promise<number> {
    return compositor.composeFrame(ctx, { scene: currentScene, resolveAsset, sources: currentSources, customBackdrop: options.customBackdrop?.(currentScene.id) });
  }

  function updateSources(sources: readonly DrawableSource[]): void {
    currentSources = sources;
    for (const button of buttons.values()) {
      const scene = sceneById(button.dataset.sceneId as SceneId);
      const slots = resolvedSceneSlots(scene, sources);
      for (const shape of button.querySelectorAll<HTMLElement>('[data-kind]')) {
        const slot = slots.find(slot=>slot.kind===shape.dataset.kind && slot.index===Number(shape.dataset.index));
        shape.hidden = !slot;
        if(slot) {shape.style.left=`${slot.rect.x/1920*100}%`;shape.style.top=`${slot.rect.y/1080*100}%`;shape.style.width=`${slot.rect.w/1920*100}%`;shape.style.height=`${slot.rect.h/1080*100}%`;}
        shape.classList.toggle('is-filled', sources.some(source => source.kind === shape.dataset.kind && source.index === Number(shape.dataset.index) && source.state === 'live'));
      }
    }
  }

  function destroy(): void {
    destroyed = true;
    selectionGeneration++;
    compositor.invalidate();
    wrapper.remove();
  }

  return {
    get currentScene() { return currentScene; },
    selectScene,
    updateSources,
    composeToCanvas,
    destroy,
  };
}
