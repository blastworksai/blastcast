// CodexBWAI — offline guest camera background processing with Apache-2.0 BodyPix.
export type CameraBackgroundMode = 'off' | 'blur' | 'image';

type Segmentation = { data: Uint8Array; width: number; height: number };
type BodyPixModel = { segmentPerson(input: HTMLVideoElement | HTMLCanvasElement, options: object): Promise<Segmentation> };
type BodyPixApi = {
  load(options: object): Promise<BodyPixModel>;
  toMask(segmentation: Segmentation, foreground: object, background: object): ImageData;
};
type TensorFlowApi = { setBackend(name: string): Promise<boolean>; ready(): Promise<void> };

declare global {
  interface Window { bodyPix?: BodyPixApi; tf?: TensorFlowApi }
}

let modelPromise: Promise<BodyPixModel> | null = null;
async function loadModel(): Promise<BodyPixModel> {
  if (!modelPromise) modelPromise = (async () => {
    const tf = window.tf, bodyPix = window.bodyPix;
    if (!tf || !bodyPix) throw new Error('Offline background processor is missing');
    const probe = document.createElement('canvas');
    const webgl = probe.getContext('webgl2') || probe.getContext('webgl');
    if (webgl) {
      try { if (!await tf.setBackend('webgl')) await tf.setBackend('cpu'); }
      catch { await tf.setBackend('cpu'); }
    } else await tf.setBackend('cpu');
    await tf.ready();
    return bodyPix.load({ architecture: 'MobileNetV1', outputStride: 16, multiplier: 0.5,
      quantBytes: 2, modelUrl: '/bodypix/model-stride16.json' });
  })().catch(error => { modelPromise = null; throw error; });
  return modelPromise;
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
    this.publish(new MediaStream([this.ownedTrack, ...raw.getAudioTracks()]));
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
      if (generation !== this.generation || raw !== this.raw) return;
      this.message('Offline background processor ready. Finishing the first frame…');
      this.paint(generation, context);
      void this.segment(generation, model);
    } catch (error) {
      if (generation === this.generation) this.fail(`Background processing could not start (${error instanceof Error ? error.message : 'unknown error'}). Your camera is unfiltered.`);
    }
  }

  private async segment(generation: number, model: BodyPixModel): Promise<void> {
    while (generation === this.generation && this.raw && this.mode !== 'off') {
      try {
        this.inference.getContext('2d')?.drawImage(this.input, 0, 0, this.inference.width, this.inference.height);
        this.segmentation = await model.segmentPerson(this.inference, { flipHorizontal: false,
          internalResolution: 'medium', segmentationThreshold: 0.7 });
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
      const segmentation = this.segmentation, bodyPix = window.bodyPix;
      if (segmentation && bodyPix) {
        const person = bodyPix.toMask(segmentation, { r: 0, g: 0, b: 0, a: 255 }, { r: 0, g: 0, b: 0, a: 0 });
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
