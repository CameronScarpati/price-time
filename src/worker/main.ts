import { Pipeline } from "./pipeline";
import type { MainToWorker, WorkerToMain } from "./protocol";

/**
 * Worker entry: owns the pipeline, answers frame requests. The main thread
 * ping-pongs ArrayBuffers here; each request is answered immediately with the
 * current engine state packed into the provided buffer (coalescing: however
 * many market events landed since the last frame, one repaint's worth of
 * state goes back).
 */
const pipeline = new Pipeline();

const post = (msg: WorkerToMain, transfer: Transferable[] = []): void => {
  (postMessage as (m: WorkerToMain, t: Transferable[]) => void)(msg, transfer);
};

onmessage = (e: MessageEvent<MainToWorker>) => {
  const msg = e.data;
  try {
    switch (msg.type) {
      case "init":
        pipeline.start(msg.mode, msg.seed, msg.replayUrl, msg.wsUrl, msg.restBase);
        break;
      case "frame": {
        const meta = pipeline.fillFrame(msg.buffer);
        post({ type: "frame", buffer: msg.buffer, meta }, [msg.buffer]);
        break;
      }
      case "pause":
        pipeline.pause();
        break;
      case "resume":
        pipeline.resume();
        break;
      case "hidden":
        pipeline.setHidden(msg.hidden);
        break;
      case "inspect":
        post({
          type: "inspection",
          token: msg.token,
          result: pipeline.inspect(msg.sides, msg.tick, msg.tickRadius, msg.cumSats, msg.satsSlop),
        });
        break;
      case "watch":
        post({ type: "inspection", token: msg.token, result: pipeline.inspectById(msg.id) });
        break;
    }
  } catch (err) {
    // Loud in development, visible in production: the page shows the failure
    // instead of freezing on a silently dead worker.
    post({ type: "fatal", message: err instanceof Error ? err.message : String(err) });
    throw err;
  }
};
