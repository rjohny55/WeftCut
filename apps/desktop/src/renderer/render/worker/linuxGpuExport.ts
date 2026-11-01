import { GPU_EXPORT_FAILURE } from "../../../shared/linuxGpuExport";
interface LowLevel {
  start(args: unknown): Promise<{ token: string } | null>;
  finish(): Promise<{ bytes: number; frames: number; elapsedMs: number }>;
  cancel(): Promise<void>;
  disable(): Promise<void>;
}
declare global {
  interface Window {
    linuxGpuExport?: LowLevel;
  }
}
let active: { port: MessagePort; token: string; next: number } | null = null;
export function gpuExportActive() {
  return active !== null;
}
export async function startGpuExport(args: unknown): Promise<boolean> {
  const api = window.linuxGpuExport;
  if (!api) return false;
  let listener: (event: MessageEvent) => void;
  let timer: ReturnType<typeof setTimeout> | undefined,
    received: MessagePort | undefined;
  const pending = new Promise<MessageEvent>((resolve) => {
    listener = (event) => {
      if (
        event.source === window &&
        event.data?.type === "gpu-export-port" &&
        event.ports.length === 1
      ) {
        received = event.ports[0];
        resolve(event);
      }
    };
    window.addEventListener("message", listener);
  });
  try {
    const descriptor = await api.start(args);
    if (!descriptor) return false;
    const event = await Promise.race([
      pending,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(Error("GPU frame port timeout")), 5000);
      }),
    ]);
    if (event.data.token !== descriptor.token)
      throw Error("GPU port token mismatch");
    const port = event.ports[0]!;
    port.start();
    active = { port, token: descriptor.token, next: 0 };
    received = undefined;
    return true;
  } catch (error) {
    if (String(error).includes("resource-capacity-exceeded")) throw error;
    console.warn("[gpu-final-export] old sink retained", error);
    await api.disable().catch(() => {});
    return false;
  } finally {
    clearTimeout(timer);
    window.removeEventListener("message", listener!);
    received?.close();
  }
}
export async function sendGpuExportFrame(index: number, bitmap: ImageBitmap) {
  const state = active;
  if (!state || index !== state.next) {
    bitmap.close();
    throw Error(GPU_EXPORT_FAILURE + ": frame sequence mismatch");
  }
  try {
    await new Promise<void>((resolve, reject) => {
      const clean = () => {
        clearTimeout(timer);
        state.port.removeEventListener("message", listener);
      };
      const listener = (event: MessageEvent) => {
        if (
          event.data?.token !== state.token ||
          event.data?.type !== "gpu-frame-ack" ||
          event.data.index !== index
        )
          return;
        clean();
        event.data.error ? reject(Error(event.data.error)) : resolve();
      };
      const timer = setTimeout(() => {
        clean();
        reject(Error("GPU frame timeout"));
      }, 15000);
      state.port.addEventListener("message", listener);
      try {
        state.port.postMessage(
          { type: "gpu-final-frame", token: state.token, index, bitmap },
          [bitmap],
        );
      } catch (error) {
        clean();
        bitmap.close();
        reject(error);
      }
    });
    state.next++;
  } catch (error) {
    throw Error(GPU_EXPORT_FAILURE + ": " + String(error));
  }
}
export async function finishGpuExport() {
  try {
    const result = await window.linuxGpuExport!.finish();
    active?.port.close();
    active = null;
    return result;
  } catch (error) {
    throw Error(GPU_EXPORT_FAILURE + ": " + String(error));
  }
}
export async function cancelGpuExport() {
  try {
    await window.linuxGpuExport!.cancel();
  } finally {
    active?.port.close();
    active = null;
  }
}
export async function disableGpuExport() {
  try {
    await window.linuxGpuExport?.disable();
  } finally {
    active?.port.close();
    active = null;
  }
}
