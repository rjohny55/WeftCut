import { describe, expect, it, vi } from 'vitest';
import type { PreviewSwFrameMsg } from '../shared/ipc';
import { forwardPreviewSwFrame } from './previewSwFrames';

describe('preview SW contextBridge routing', () => {
  it('does not cross the bridge for another stream or consume its receipt', () => {
    const own = vi.fn(), foreign = vi.fn();
    const frame = { streamId: 'own', data: new Uint8Array(8), receipt: 42 } as PreviewSwFrameMsg;
    forwardPreviewSwFrame(frame, 'own', own);
    forwardPreviewSwFrame(frame, 'foreign', foreign);
    expect(own).toHaveBeenCalledExactlyOnceWith(frame);
    expect(own.mock.calls[0]![0]).toBe(frame);
    expect(foreign).not.toHaveBeenCalled();
  });

  it('preserves legacy unscoped subscriptions and consumer errors', () => {
    const frame = { streamId: 's' } as PreviewSwFrameMsg;
    const callback = vi.fn(() => { throw new Error('consumer'); });
    expect(() => forwardPreviewSwFrame(frame, undefined, callback)).toThrow('consumer');
    expect(callback).toHaveBeenCalledExactlyOnceWith(frame);
  });
});
