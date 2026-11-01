import { GPU_EXPORT_FAILURE } from "../../shared/linuxGpuExport";
/** Restart from frame zero, never concatenate incompatible encoded streams. */
export async function withGpuExportFallback<T>(
  run: () => Promise<T>,
  restart: () => Promise<void>,
  active: () => boolean,
  cancelled: () => boolean,
): Promise<T> {
  try {
    return await run();
  } catch (error) {
    const message = String(error).replace(/^(?:Error:\s*)+/, "");
    const transport =
      message === GPU_EXPORT_FAILURE ||
      message.startsWith(GPU_EXPORT_FAILURE + ":");
    if (cancelled() || !active() || !transport) throw error;
    await restart();
    return run(); // exactly one retry; a second error is visible
  }
}
