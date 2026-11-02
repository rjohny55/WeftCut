import type { PreviewSwFrameMsg } from '../shared/ipc';

/** Filter before calling a contextBridge function: crossing worlds clones the
 * whole pixel buffer even when the renderer then rejects a foreign stream.
 * Receipts remain owned by the matching transport, never by this filter. */
export function forwardPreviewSwFrame(
  frame: PreviewSwFrameMsg,
  streamId: string | undefined,
  callback: (frame: PreviewSwFrameMsg) => void,
): void {
  if (streamId === undefined || frame.streamId === streamId) callback(frame);
}
