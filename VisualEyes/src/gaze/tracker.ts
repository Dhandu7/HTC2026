// Webcam + MediaPipe Face Landmarker. Produces per-frame gaze features on-device;
// no frames ever leave the machine.
import { FaceLandmarker, FilesetResolver } from "@mediapipe/tasks-vision";
import { extractFeatures, type GazeFeatures } from "./features";

const CDN_WASM = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.2.2/wasm";
const CDN_MODEL =
  "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task";

/** Raw MediaPipe output for one frame, kept so sessions can be recorded and replayed offline. */
export interface RawFace {
  /** 478 landmarks flattened as x,y,z (normalised image coordinates). */
  lm: Float32Array;
  /** Blendshape scores in MediaPipe's category order (see blendNames). */
  blend: Float32Array;
  blendNames: string[];
  /** Column-major 4x4 facial transformation matrix, if available. */
  matrix: number[] | null;
}

export interface FaceFrame extends GazeFeatures {
  t: number;
  /** Detection latency for this frame (ms). */
  inferMs: number;
  raw: RawFace;
}

/** True if a local asset exists (Vite's SPA fallback returns HTML for missing files, so check content type). */
async function hasLocal(url: string): Promise<boolean> {
  try {
    const r = await fetch(url, { method: "HEAD" });
    return r.ok && !(r.headers.get("content-type") ?? "").includes("text/html");
  } catch {
    return false;
  }
}

export class FaceTracker {
  private landmarker: FaceLandmarker | null = null;
  private video: HTMLVideoElement;
  private stream: MediaStream | null = null;
  private running = false;
  private lastVideoTime = -1;
  fps = 0;
  private frameTimes: number[] = [];
  onFrame: (f: FaceFrame | null) => void = () => {};

  constructor(video: HTMLVideoElement) {
    this.video = video;
  }

  async init(): Promise<string> {
    const localWasm = await hasLocal("./mediapipe/wasm/vision_wasm_internal.wasm");
    const localModel = await hasLocal("./models/face_landmarker.task");
    const fileset = await FilesetResolver.forVisionTasks(localWasm ? "./mediapipe/wasm" : CDN_WASM);
    const opts = (delegate: "GPU" | "CPU") => ({
      baseOptions: { modelAssetPath: localModel ? "./models/face_landmarker.task" : CDN_MODEL, delegate },
      runningMode: "VIDEO" as const,
      numFaces: 1,
      outputFaceBlendshapes: true,
      outputFacialTransformationMatrixes: true,
    });
    try {
      this.landmarker = await FaceLandmarker.createFromOptions(fileset, opts("GPU"));
    } catch {
      this.landmarker = await FaceLandmarker.createFromOptions(fileset, opts("CPU"));
    }
    return localWasm && localModel ? "offline assets" : "CDN assets";
  }

  async start(deviceId?: string): Promise<void> {
    this.stream = await navigator.mediaDevices.getUserMedia({
      video: {
        deviceId: deviceId ? { exact: deviceId } : undefined,
        width: { ideal: 1280 },
        height: { ideal: 720 },
        frameRate: { ideal: 30 },
        facingMode: "user",
      },
      audio: false,
    });
    this.video.srcObject = this.stream;
    await this.video.play();
    this.running = true;
    this.loop();
  }

  stop() {
    this.running = false;
    this.stream?.getTracks().forEach((t) => t.stop());
  }

  /** The live camera stream (for local session video recording). */
  get mediaStream(): MediaStream | null {
    return this.stream;
  }

  get videoSize(): { width: number; height: number } {
    return { width: this.video.videoWidth, height: this.video.videoHeight };
  }

  get cameraLabel(): string {
    return this.stream?.getVideoTracks()[0]?.label ?? "";
  }

  private loop = () => {
    if (!this.running || !this.landmarker) return;
    const v = this.video;
    if (v.readyState >= 2 && v.currentTime !== this.lastVideoTime) {
      this.lastVideoTime = v.currentTime;
      const t = performance.now();
      const res = this.landmarker.detectForVideo(v, t);
      const inferMs = performance.now() - t;
      this.frameTimes.push(t);
      while (this.frameTimes.length && t - this.frameTimes[0] > 1000) this.frameTimes.shift();
      this.fps = this.frameTimes.length;
      const lm = res.faceLandmarks?.[0];
      if (!lm) {
        this.onFrame(null);
      } else {
        const blend: Record<string, number> = {};
        const cats = res.faceBlendshapes?.[0]?.categories ?? [];
        for (const c of cats) blend[c.categoryName] = c.score;
        const matrix = res.facialTransformationMatrixes?.[0]?.data;
        const f = extractFeatures(lm, blend, matrix, v.videoWidth / v.videoHeight);
        const flat = new Float32Array(lm.length * 3);
        lm.forEach((p, i) => {
          flat[i * 3] = p.x;
          flat[i * 3 + 1] = p.y;
          flat[i * 3 + 2] = p.z ?? 0;
        });
        const raw: RawFace = {
          lm: flat,
          blend: Float32Array.from(cats, (c) => c.score),
          blendNames: cats.map((c) => c.categoryName),
          matrix: matrix ? Array.from(matrix) : null,
        };
        this.onFrame({ ...f, t, inferMs, raw });
      }
    }
    // requestVideoFrameCallback keeps us in lockstep with the camera where supported.
    if ("requestVideoFrameCallback" in v) v.requestVideoFrameCallback(() => this.loop());
    else requestAnimationFrame(this.loop);
  };
}
