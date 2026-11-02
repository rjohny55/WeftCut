// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
vi.mock('../../ipc', () => ({ logEmit: vi.fn(async () => {}) }));
vi.mock('../resourceClient', () => ({ acquireRenderResources: vi.fn(async () => () => {}) }));
import { SourceHandle, SourceMedia } from './SourceDecoderPool';

class Decoder {
  static instances: Decoder[] = [];
  state: CodecState = 'unconfigured';
  config: VideoDecoderConfig | null = null;
  decodeQueueSize = 0;
  constructor(readonly handlers: VideoDecoderInit) { Decoder.instances.push(this); }
  configure(config: VideoDecoderConfig) { this.config = config; this.state = 'configured'; }
  close() { this.state = 'closed'; }
  reset() { this.state = 'unconfigured'; }
  decode() {}
  flush() { return Promise.resolve(); }
  fail() { this.state = 'closed'; this.handlers.error(new DOMException('Decoding error.', 'EncodingError')); }
}
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); Decoder.instances = []; });

it('midstream terminal hardware failure rebuilds software once and rejects stale bitmap output', async () => {
  vi.stubGlobal('VideoDecoder', Decoder);
  const media = new SourceMedia('test-proxy', 'weftcut-media://proxy.mp4');
  vi.spyOn(media, 'ensureReady').mockResolvedValue({ codec: 'avc1.42c01f', codedWidth: 1092, codedHeight: 720 });
  vi.spyOn(media, 'packetSink', 'get').mockReturnValue({} as never);
  const handle = new SourceHandle('test-layer', media);
  const bitmaps: Array<{ close: ReturnType<typeof vi.fn> }> = [];
  let releaseLate!: (bitmap: ImageBitmap) => void;
  vi.stubGlobal('createImageBitmap', vi.fn()
    .mockImplementationOnce(async () => { const b = { width: 1092, height: 720, close: vi.fn() }; bitmaps.push(b); return b; })
    .mockImplementationOnce(() => new Promise(resolve => { releaseLate = resolve; })));
  await handle.ensureReady();
  const hardware = Decoder.instances[0]!;
  const first = { timestamp: 92_400_000, duration: 33_333, close: vi.fn() };
  hardware.handlers.output(first as unknown as VideoFrame);
  await Promise.resolve();
  expect(handle.decodedFrameCount()).toBe(1);
  hardware.handlers.output({ ...first, timestamp: 92_433_333, close: vi.fn() } as unknown as VideoFrame);
  hardware.fail();
  expect(handle.isDowngraded()).toBe(true);
  await handle.ensureReady();
  const software = Decoder.instances[1]!;
  expect(software.config?.hardwareAcceleration).toBe('prefer-software');
  const stale = { close: vi.fn() };
  releaseLate(stale as unknown as ImageBitmap);
  await Promise.resolve();
  expect(stale.close).toHaveBeenCalledOnce();
  expect(handle.decodedFrameCount()).toBe(1);
  software.fail();
  expect(Decoder.instances).toHaveLength(2);
  expect(handle.isDowngraded()).toBe(true);
  handle.dispose(); media.dispose();
});
