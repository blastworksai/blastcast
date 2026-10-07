// ClaudeBWAI — offline guest/host camera background processing, now on Apache-2.0 MediaPipe Tasks Vision (ImageSegmenter + selfie segmenter), served from /mediapipe/ on this device; it began as CodexBWAI's BodyPix version.
export type CameraBackgroundMode = 'off' | 'blur' | 'image';

type Segmentation = ImageData;
type MediaPipeMask = { width: number; height: number; getAsFloat32Array(): Float32Array; close(): void };
type MediaPipeResult = { confidenceMasks?: MediaPipeMask[]; close?(): void };
type Segmenter = {
  segmentForVideo(frame: HTMLCanvasElement, timestamp: number, callback: (result: MediaPipeResult) => void): void;
};
type MediaPipeModule = {
  FilesetResolver: { forVisionTasks(basePath: string): Promise<object> };
  ImageSegmenter: { createFromOptions(fileset: object, options: object): Promise<Segmenter> };
};

const bundleUrl = '/mediapipe/vision_bundle.mjs', wasmPath = '/mediapipe/wasm', modelUrl = '/mediapipe/selfie_segmenter.tflite';
let modelPromise: Promise<Segmenter> | null = null;
async function loadModel(): Promise<Segmenter> {
  if (!modelPromise) modelPromise = (async () => {
    let mediapipe: MediaPipeModule;
    try { mediapipe = await import(/* @vite-ignore */ bundleUrl) as MediaPipeModule; }
    catch { throw new Error('Offline background processor is missing'); }
    const fileset = await mediapipe.FilesetResolver.forVisionTasks(wasmPath);
    const create = (delegate: 'GPU' | 'CPU') => mediapipe.ImageSegmenter.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: modelUrl, delegate }, runningMode: 'VIDEO', outputCategoryMask: false, outputConfidenceMasks: true });
    try { return await create('GPU'); } catch { return create('CPU'); }
  })().catch(error => { modelPromise = null; throw error; });
  return modelPromise;
}

let lastTimestamp = 0;
/** Person confidence (0..1) to an alpha mask at the mask's own size; a soft threshold keeps edges smooth. */
function maskToImageData(mask: MediaPipeMask): ImageData {
  const confidence = mask.getAsFloat32Array(), out = new ImageData(mask.width, mask.height), data = out.data;
  for (let i = 0; i < confidence.length; i++) {
    const t = Math.min(1, Math.max(0, ((confidence[i] ?? 0) - 0.35) / 0.3));
    data[i * 4 + 3] = Math.round(t * t * (3 - 2 * t) * 255);
  }
  return out;
}

export function coverRect(sourceWidth: number, sourceHeight: number, width: number, height: number): [number, number, number, number] {
  if (![sourceWidth, sourceHeight, width, height].every(value => Number.isFinite(value) && value > 0)) throw new Error('Invalid image dimensions');
  const scale = Math.max(width / sourceWidth, height / sourceHeight);
  const drawnWidth = sourceWidth * scale, drawnHeight = sourceHeight * scale;
  return [(width - drawnWidth) / 2, (height - drawnHeight) / 2, drawnWidth, drawnHeight];
}

export class CameraBackground {
  mode: CameraBackgroundMode = 'off';
  private raw: MediaStream | null = null;
  private output: MediaStream | null = null;
  private ownedTrack: MediaStreamTrack | null = null;
  private image: HTMLImageElement | null = null;
  private generation = 0;
  private frame = 0;
  private input = document.createElement('video');
  private canvas = document.createElement('canvas');
  private mask = document.createElement('canvas');
  private inference = document.createElement('canvas');
  private segmentation: Segmentation | null = null;

  constructor(private changed: (stream: MediaStream | null) => void, private message: (text: string, error?: boolean) => void) {
    this.input.muted = true; this.input.playsInline = true;
  }

  get hasImage(): boolean { return this.image !== null; }

  setSource(stream: MediaStream | null): void {
    this.generation++;
    this.stopProcessed();
    this.raw = stream;
    this.input.pause(); this.input.srcObject = stream;
    if (!stream || this.mode === 'off') this.publish(stream);
    else void this.startProcessed(this.generation);
  }

  // ClaudeBWAI — one device changed while the other keeps running (studio Mic/Camera toggle, Reconnect).
  /** A microphone change: the camera processing keeps running; the new audio is published beside the same video. */
  replaceAudio(stream: MediaStream): void {
    this.raw = stream;
    if (this.mode !== 'off' && this.ownedTrack?.readyState === 'live') this.publish(new MediaStream([this.ownedTrack, ...stream.getAudioTracks()]));
    else if (this.mode === 'off' || !this.ownedTrack) this.publish(stream);
  }
  /** A camera restart: an effect already running keeps its output track and only reads the new camera, so whatever
   * records that track (the host original) is not ended. Anything else is an ordinary setSource. */
  swapCamera(stream: MediaStream): void {
    if (this.raw && this.mode !== 'off' && this.ownedTrack?.readyState === 'live' && stream.getVideoTracks().length) {
      this.raw = stream;
      this.input.srcObject = stream; void this.input.play().catch(() => {});
      this.publish(new MediaStream([this.ownedTrack, ...stream.getAudioTracks()]));
      return;
    }
    this.setSource(stream);
  }

  async setMode(mode: CameraBackgroundMode): Promise<void> {
    if (!['off', 'blur', 'image'].includes(mode)) throw new Error('Unsupported background mode');
    if (mode === 'image' && !this.image) throw new Error('Choose a background image first.');
    if (mode === this.mode) return;
    const previous = this.mode;
    this.mode = mode;
    if (this.raw && previous !== 'off' && mode !== 'off' && this.ownedTrack?.readyState === 'live') {
      this.message(mode === 'blur' ? 'Switching to background blur…' : 'Switching to your background image…');
      return;
    }
    this.generation++;
    this.stopProcessed();
    if (!this.raw || mode === 'off') {
      this.publish(this.raw);
      this.message(mode === 'off' ? 'Camera background is off.' : 'The effect will start when your camera turns on.');
      return;
    }
    await this.startProcessed(this.generation);
  }

  async setImage(file: File): Promise<void> {
    if (!['image/png', 'image/jpeg'].includes(file.type) || file.size <= 0 || file.size > 15 * 1024 * 1024) throw new Error('Choose a PNG or JPEG image up to 15 MB.');
    const url = URL.createObjectURL(file);
    try {
      const image = new Image(); image.decoding = 'async'; image.src = url; await image.decode();
      if (!image.naturalWidth || !image.naturalHeight || image.naturalWidth > 8192 || image.naturalHeight > 8192 || image.naturalWidth * image.naturalHeight > 40_000_000) {
        throw new Error('Image dimensions are unsafe');
      }
      this.image = image;
    } catch { throw new Error('That background image could not be opened. Choose another PNG or JPEG.'); }
    finally { URL.revokeObjectURL(url); }
    await this.setMode('image');
  }

  close(): void { this.generation++; this.stopProcessed(); this.raw = null; this.publish(null); }

  private publish(stream: MediaStream | null): void {
    if (stream === this.output) return;
    this.output = stream; this.changed(stream);
  }

  private stopProcessed(): void {
    clearTimeout(this.frame); this.frame = 0; this.segmentation = null;
    this.ownedTrack?.stop(); this.ownedTrack = null;
  }

  private async startProcessed(generation: number): Promise<void> {
    const raw = this.raw;
    if (!raw || this.mode === 'off' || generation !== this.generation) return;
    const settings = raw.getVideoTracks()[0]?.getSettings() ?? {};
    const width = Math.max(1, settings.width ?? 1280), height = Math.max(1, settings.height ?? 720);
    this.canvas.width = this.mask.width = width; this.canvas.height = this.mask.height = height;
    const context = this.canvas.getContext('2d');
    if (!context || typeof this.canvas.captureStream !== 'function') return this.fail('Background effects are unavailable in this browser.');
    context.fillStyle = '#111'; context.fillRect(0, 0, width, height);
    const processed = this.canvas.captureStream(Math.min(30, settings.frameRate ?? 30));
    this.ownedTrack = processed.getVideoTracks()[0] ?? null;
    if (!this.ownedTrack) return this.fail('Background effects could not create a camera track.');
    this.publish(new MediaStream([this.ownedTrack, ...(this.raw ?? raw).getAudioTracks()]));
    this.message('Loading the offline background processor…');
    try {
      await this.input.play();
      for (let attempt = 0; attempt < 100 && (!this.input.videoWidth || !this.input.videoHeight); attempt++) {
        await new Promise(resolve => setTimeout(resolve, 50));
        if (generation !== this.generation) return;
      }
      if (!this.input.videoWidth || !this.input.videoHeight) throw new Error('Camera frames are not ready');
      const scale = Math.min(1, 640 / this.input.videoWidth);
      this.inference.width = Math.max(1, Math.round(this.input.videoWidth * scale));
      this.inference.height = Math.max(1, Math.round(this.input.videoHeight * scale));
      const model = await loadModel();
      // ClaudeBWAI — replaceAudio/swapCamera change raw without a new generation; this run carries on with them.
      if (generation !== this.generation || !this.raw?.getVideoTracks().length) return;
      this.message('Offline background processor ready. Finishing the first frame…');
      this.paint(generation, context);
      void this.segment(generation, model);
    } catch (error) {
      if (generation === this.generation) this.fail(`Background processing could not start (${error instanceof Error ? error.message : 'unknown error'}). Your camera is unfiltered.`);
    }
  }

  private async segment(generation: number, model: Segmenter): Promise<void> {
    while (generation === this.generation && this.raw && this.mode !== 'off') {
      try {
        this.inference.getContext('2d')?.drawImage(this.input, 0, 0, this.inference.width, this.inference.height);
        const timestamp = lastTimestamp = Math.max(performance.now(), lastTimestamp + 1);
        // The callback form closes the result and its masks for us as soon as it returns; copy out what we need inside it.
        model.segmentForVideo(this.inference, timestamp, result => {
          const mask = result.confidenceMasks?.[0];
          if (mask) this.segmentation = maskToImageData(mask);
        });
        if (generation === this.generation) this.message(this.mode === 'blur'
          ? 'Background blur is on. Processing stays on this device.'
          : 'Background image is on. The image and processing stay on this device.');
      } catch (error) {
        if (generation === this.generation) this.fail(`Background processing stopped (${error instanceof Error ? error.message : 'unknown error'}; ${this.input.videoWidth}×${this.input.videoHeight} input). Your camera is unfiltered.`);
        return;
      }
      await new Promise(resolve => setTimeout(resolve, 40));
    }
  }

  private paint(generation: number, context: CanvasRenderingContext2D): void {
    const draw = () => {
      if (generation !== this.generation || !this.raw || this.mode === 'off') return;
      const person = this.segmentation;
      if (person) {
        if (person.width > 0 && person.height > 0) {
          context.globalCompositeOperation = 'source-over';
          context.filter = 'none';
          context.drawImage(this.input, 0, 0, this.canvas.width, this.canvas.height);
          this.mask.width = person.width; this.mask.height = person.height;
          this.mask.getContext('2d')?.putImageData(person, 0, 0);
          context.globalCompositeOperation = 'destination-in';
          context.drawImage(this.mask, 0, 0, this.canvas.width, this.canvas.height);
          context.globalCompositeOperation = 'destination-over';
          if (this.mode === 'blur') {
            context.filter = 'blur(14px)';
            context.drawImage(this.input, -14, -14, this.canvas.width + 28, this.canvas.height + 28);
          } else if (this.image) {
            context.drawImage(this.image, ...coverRect(this.image.naturalWidth, this.image.naturalHeight, this.canvas.width, this.canvas.height));
          }
          context.filter = 'none'; context.globalCompositeOperation = 'source-over';
        }
      }
      this.frame = window.setTimeout(draw, 33);
    };
    draw();
  }

  private fail(text: string): void {
    this.generation++; this.stopProcessed(); this.mode = 'off'; this.publish(this.raw); this.message(text, true);
  }
}
