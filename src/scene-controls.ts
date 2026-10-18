// BCAST-14 scene-controls adapter — Antigravity_CLI
import type { SceneId, SceneDefinition, AssetResolver, DrawableSource, CompositorOptions, SceneArrangement, CameraPlacement, SceneSlot } from './scenes.js';
import type { FrameCompositor } from './scenes.js';
import { DEFAULT_SCENES, sceneById, SceneCompositor, resolvedSceneSlots, cameraPosition, CANVAS_W, CANVAS_H } from './scenes.js';

export interface SceneControlsOptions {
  readonly container: HTMLElement;
  readonly resolveAsset: AssetResolver;
  readonly onSceneSelected: (scene: SceneDefinition) => void;
  readonly customBackdrop?: (id: SceneId) => boolean;
  readonly arrange?: {
    readonly viewfinder: HTMLElement;
    load(): Promise<{ok:boolean;arrangements?:Partial<Record<SceneId,SceneArrangement>>;message?:string}>;
    save(id:SceneId,frames:SceneArrangement): Promise<{ok:boolean;message?:string}>;
    reset(id:SceneId): Promise<{ok:boolean;message?:string}>;
  };
  readonly brand?: { readonly primary?: string; readonly surface?: string; readonly text?: string; };
}

export interface SceneControlsHandle {
  readonly currentScene: SceneDefinition;
  selectScene(id: SceneId): void;
  updateSources(sources: readonly DrawableSource[]): void;
  /** ClaudeBWAI — einh 4 Oct (CP4c): accepts a 2D context (as before) or any FrameCompositor (Canvas 2D or WebGL2). */
  composeToCanvas(target: CanvasRenderingContext2D | FrameCompositor): Promise<number>;
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
  // CodexBWAI — settings are per scene; an unlocked scene retains its in-session edits when switching.
  let arrangements: Partial<Record<SceneId,SceneArrangement>> = {};
  const unlocked = new Set<SceneId>();
  let arrangementReady = false, arrangementBusy = false;
  let drag: {id:number;scene:SceneId;index:number;clientX:number;clientY:number;x:number;y:number} | null = null;
  const handles = new Map<number,HTMLButtonElement>();
  const layer = document.createElement('div'); layer.className='camera-arrangement-layer'; layer.hidden=true;
  // The canvas uses object-fit:contain. Match its displayed 16:9 content, including letterboxing.
  function sizeLayer(): void {
    if (!options.arrange) return;
    const view=options.arrange.viewfinder,w=view.clientWidth,h=view.clientHeight;
    const scale=Math.min(w/CANVAS_W,h/CANVAS_H),width=CANVAS_W*scale,height=CANVAS_H*scale;
    Object.assign(layer.style,{inset:'auto',left:`${(w-width)/2}px`,top:`${(h-height)/2}px`,width:`${width}px`,height:`${height}px`});
  }
  const sizeWatch=options.arrange?new ResizeObserver(sizeLayer):null;
  if (options.arrange) sizeWatch!.observe(options.arrange.viewfinder);
  const bar = document.createElement('div'); bar.className='camera-arrangement-controls';
  const toggle = document.createElement('button'); toggle.id='arrangement-toggle';toggle.className='secondary';toggle.type='button';
  const reset = document.createElement('button');reset.id='reset-arrangement';reset.className='secondary';reset.type='button';reset.textContent='Reset this scene';
  const notice = document.createElement('p');notice.id='arrangement-status';notice.className='small';notice.setAttribute('role','status');
  const confirmation = document.createElement('dialog');confirmation.id='arrangement-reset-dialog';
  const explanation=document.createElement('p');explanation.textContent='Reset camera positions for this scene? Other scenes keep their arrangements.';
  const cancelReset=document.createElement('button');cancelReset.type='button';cancelReset.textContent='Cancel';cancelReset.className='secondary';
  const confirmReset=document.createElement('button');confirmReset.type='button';confirmReset.textContent='Reset this scene';confirmReset.className='primary';
  confirmation.append(explanation,cancelReset,confirmReset);bar.append(toggle,reset);

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
  if (options.arrange) {
    options.arrange.viewfinder.append(layer);container.append(bar,notice,confirmation);
    toggle.addEventListener('click', () => { void changeLock(); });
    reset.addEventListener('click', () => { if (!arrangementReady || arrangementBusy) return; resetScene=currentScene.id;confirmation.showModal(); });
    cancelReset.addEventListener('click', () => confirmation.close());
    confirmReset.addEventListener('click', () => { void resetConfirmed(); });
    void options.arrange.load().then(result => {
      if (destroyed) return;
      if (!result.ok) throw new Error(result.message || 'Saved camera arrangements could not load. Reopen BlastCast to retry.');
      arrangements=result.arrangements ?? {};arrangementReady=true;notice.textContent='Unlock to move camera frames. Lock saves this scene.';refreshHandles();
    }).catch(error => { if (!destroyed) {notice.textContent=error instanceof Error?error.message:'Saved camera arrangements could not load.';refreshHandles();} });
    refreshHandles();
  }

  function cameraSlots(): SceneSlot[] {
    const frames=arrangements[currentScene.id];
    const slots=resolvedSceneSlots(currentScene,currentSources).filter(slot=>slot.kind==='camera').map(slot=>{
      const frame=frames?.find(frame=>frame.index===slot.index);
      return frame?{...slot,rect:cameraPosition(slot.rect,frame.x,frame.y)}:slot;
    });
    return frames?slots.sort((a,b)=>frames.findIndex(frame=>frame.index===a.index)-frames.findIndex(frame=>frame.index===b.index)):slots;
  }
  function currentFrames(): CameraPlacement[] {
    // Retain absent screen-scene slots so a departing/rejoining guest does not erase saved placement.
    const previous=arrangements[currentScene.id] ?? [];
    const slots=cameraSlots();
    return [...previous.filter(frame=>!slots.some(slot=>slot.index===frame.index)),...slots.map(slot=>({index:slot.index,x:slot.rect.x,y:slot.rect.y}))];
  }
  function pick(index:number): void {
    if (!unlocked.has(currentScene.id) || arrangementBusy) return;
    const frames=currentFrames();const frame=frames.find(frame=>frame.index===index);
    if (frame) arrangements[currentScene.id]=[...frames.filter(frame=>frame.index!==index),frame];
    refreshHandles();
  }
  function moveFrame(index:number,x:number,y:number): void {
    const slot=cameraSlots().find(slot=>slot.index===index);if (!slot) return;
    const rect=cameraPosition(slot.rect,x,y);
    arrangements[currentScene.id]=currentFrames().map(frame=>frame.index===index?{index,x:rect.x,y:rect.y}:frame);
    refreshHandles();
  }
  function refreshHandles(): void {
    if (!options.arrange) return;
    sizeLayer();
    toggle.disabled=reset.disabled=!arrangementReady||arrangementBusy;
    const editing=unlocked.has(currentScene.id);
    toggle.textContent=editing?'Lock arrangement':'Unlock arrangement';toggle.setAttribute('aria-pressed',String(editing));
    layer.hidden=!editing;layer.setAttribute('aria-label','Move camera frames');
    const slots=cameraSlots();
    for (const [index,button] of handles) if (!slots.some(slot=>slot.index===index)) {button.remove();handles.delete(index);}
    slots.forEach((slot,order)=>{
      let button=handles.get(slot.index);
      if (!button) {
        button=document.createElement('button');button.type='button';button.className='camera-arrangement-frame';button.dataset.cameraIndex=String(slot.index);
        button.textContent=slot.index===0?'Host camera':`Camera ${slot.index+1}`;
        button.setAttribute('aria-label',`Move ${button.textContent}. Use arrow keys; Shift moves faster.`);
        const index=slot.index;
        button.addEventListener('focus',()=>pick(index));
        button.addEventListener('pointerdown',event=>{
          if (event.button!==0||arrangementBusy||!unlocked.has(currentScene.id)) return;
          event.preventDefault();button!.focus();pick(index);
          const frame=cameraSlots().find(slot=>slot.index===index)!;
          drag={id:event.pointerId,scene:currentScene.id,index,clientX:event.clientX,clientY:event.clientY,x:frame.rect.x,y:frame.rect.y};
          button!.setPointerCapture(event.pointerId);
        });
        button.addEventListener('pointermove',event=>{
          if (!drag||drag.id!==event.pointerId||drag.scene!==currentScene.id||arrangementBusy) return;
          const rect=layer.getBoundingClientRect();
          if (rect.width&&rect.height) moveFrame(index,drag.x+(event.clientX-drag.clientX)*CANVAS_W/rect.width,drag.y+(event.clientY-drag.clientY)*CANVAS_H/rect.height);
        });
        const end=(event:PointerEvent)=>{if (drag?.id===event.pointerId) drag=null;};
        button.addEventListener('pointerup',end);button.addEventListener('pointercancel',end);button.addEventListener('lostpointercapture',()=>{drag=null;});
        button.addEventListener('keydown',event=>{
          const direction=({ArrowLeft:[-1,0],ArrowRight:[1,0],ArrowUp:[0,-1],ArrowDown:[0,1]} as Record<string,number[]>)[event.key];
          if (!direction||arrangementBusy||!unlocked.has(currentScene.id)) return;
          event.preventDefault();pick(index);const frame=cameraSlots().find(slot=>slot.index===index)!;const step=event.shiftKey?10:1;
          moveFrame(index,frame.rect.x+direction[0]!*step,frame.rect.y+direction[1]!*step);
        });
        handles.set(index,button);layer.append(button);
      }
      button.disabled=arrangementBusy;
      Object.assign(button.style,{left:`${slot.rect.x/CANVAS_W*100}%`,top:`${slot.rect.y/CANVAS_H*100}%`,width:`${slot.rect.w/CANVAS_W*100}%`,height:`${slot.rect.h/CANVAS_H*100}%`,zIndex:String(order+1)});
    });
  }
  async function changeLock(): Promise<void> {
    if (!options.arrange||!arrangementReady||arrangementBusy) return;
    const id=currentScene.id;
    if (!unlocked.has(id)) {
      arrangements[id]=currentFrames();unlocked.add(id);notice.textContent='Unlocked. Drag frames or use arrow keys. Lock saves this scene.';refreshHandles();return;
    }
    drag=null;arrangementBusy=true;refreshHandles();
    try {
      const result=await options.arrange.save(id,currentFrames());
      if (destroyed) return;
      if (!result.ok) throw new Error(result.message||'Camera positions could not save. Keep the studio open and lock again to retry.');
      unlocked.delete(id);notice.textContent='Camera positions saved for this scene.';
    } catch(error) { if (!destroyed) notice.textContent=error instanceof Error?error.message:'Camera positions could not save. Lock again to retry.'; }
    finally { arrangementBusy=false;if(!destroyed)refreshHandles(); }
  }
  let resetScene:SceneId=currentScene.id;
  async function resetConfirmed():Promise<void> {
    if (!options.arrange||arrangementBusy) return;
    const id=resetScene;confirmation.close();drag=null;arrangementBusy=true;refreshHandles();
    try {
      const result=await options.arrange.reset(id);
      if (destroyed) return;
      if (!result.ok) throw new Error(result.message||'Camera positions could not reset. Try again.');
      delete arrangements[id];unlocked.delete(id);notice.textContent='Default camera positions restored for this scene.';
    } catch(error) { if (!destroyed) notice.textContent=error instanceof Error?error.message:'Camera positions could not reset.'; }
    finally {arrangementBusy=false;if(!destroyed)refreshHandles();}
  }

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
    drag=null;
    currentScene = scene;
    refreshHandles();
    updateButtonStates();
    if (gen === selectionGeneration) onSceneSelected(scene);
  }

  async function composeToCanvas(target: CanvasRenderingContext2D | FrameCompositor): Promise<number> {
    if (typeof (target as FrameCompositor).draw === 'function' && 'backend' in target) {
      return compositor.composeWith(target as FrameCompositor, { scene: currentScene, resolveAsset, sources: currentSources, customBackdrop: options.customBackdrop?.(currentScene.id), arrangement: arrangements[currentScene.id] });
    }
    const ctx = target as CanvasRenderingContext2D;
    return compositor.composeFrame(ctx, { scene: currentScene, resolveAsset, sources: currentSources, customBackdrop: options.customBackdrop?.(currentScene.id), arrangement: arrangements[currentScene.id] });
  }

  function updateSources(sources: readonly DrawableSource[]): void {
    currentSources = sources;
    refreshHandles();
    for (const button of buttons.values()) {
      const scene = sceneById(button.dataset.sceneId as SceneId);
      const slots = resolvedSceneSlots(scene, sources);
      for (const shape of button.querySelectorAll<HTMLElement>('[data-kind]')) {
        const slot = slots.find(slot=>slot.kind===shape.dataset.kind && slot.index===Number(shape.dataset.index));
        shape.hidden = !slot;
        if(slot) {shape.style.left=`${slot.rect.x/1920*100}%`;shape.style.top=`${slot.rect.y/1080*100}%`;shape.style.width=`${slot.rect.w/1920*100}%`;shape.style.height=`${slot.rect.h/1080*100}%`;}
        shape.classList.toggle('is-filled', sources.some(source => source.kind === shape.dataset.kind && source.index === Number(shape.dataset.index) && (source.state === 'live' || source.state === 'reconnecting')));
      }
    }
  }

  function destroy(): void {
    destroyed = true;
    selectionGeneration++;
    compositor.invalidate();
    sizeWatch?.disconnect();wrapper.remove();layer.remove();bar.remove();notice.remove();confirmation.remove();handles.clear();drag=null;
  }

  return {
    get currentScene() { return currentScene; },
    selectScene,
    updateSources,
    composeToCanvas,
    destroy,
  };
}
