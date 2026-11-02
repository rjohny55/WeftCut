import { describe, expect, it, vi } from 'vitest';
import { PreviewCaptureResidency, previewCaptureHostLimit, type PreviewPageIdentity } from './previewCaptureResidency';

const page = (packageId: string, revision = 'v1'): PreviewPageIdentity => ({ packageId, revision,
  width: 1920, height: 1080, fpsNum: 30, fpsDen: 1, texture: false });
function setup(maxHosts = 3) {
  let id = 0;
  const close = vi.fn(), closeFallback = vi.fn(), create = vi.fn((size: number) => ({ id: ++id, size }));
  const cache = new PreviewCaptureResidency({ maxHosts, create, close, closeFallback,
    fallback: { id: 0, size: 0 }, capacity: error => String(error).includes('capacity') });
  const use = (identity: PreviewPageIdentity) => cache.use(identity, 200, () => true, async slot => slot.id);
  return { cache, create, close, closeFallback, use };
}

describe('preview resident documents', () => {
  it('defaults off, clamps limits and rejects invalid configuration', () => {
    expect([undefined, 'bad', '0', '-1', '3.5'].map(previewCaptureHostLimit)).toEqual([1, 1, 1, 1, 1]);
    expect(previewCaptureHostLimit('3')).toBe(3);
    expect(previewCaptureHostLimit('8')).toBe(8);
    expect(previewCaptureHostLimit('99')).toBe(8);
  });

  it('retains A → B → A without sharing a document clock or growing beyond cap', async () => {
    const { cache, use, create, close } = setup(2);
    expect(await use(page('A'))).toBe(1); expect(await use(page('B'))).toBe(2);
    expect(await use(page('A'))).toBe(1);
    expect(await use(page('C'))).toBe(3);
    expect(create).toHaveBeenCalledTimes(3);
    expect(close.mock.calls.map(([v]) => v.id)).toEqual([2]);
    expect(cache.diagnostics).toMatchObject({ hosts: 2, peakHosts: 2, hits: 1 });
  });

  it('keys exact revision, geometry, fps and output mode, not mutable props', async () => {
    const { use, close } = setup(8);
    const a = page('A');
    expect(await use(a)).toBe(1);
    expect(await use({ ...a, width: 1280 })).toBe(2);
    expect(await use({ ...a, fpsNum: 60 })).toBe(3);
    expect(await use({ ...a, texture: true })).toBe(4);
    expect(await use(page('A', 'v2'))).toBe(5);
    expect(close).toHaveBeenCalledTimes(4);
  });

  it('capacity refusal releases idle pages and uses the unchanged serial fallback', async () => {
    const { use, create, close, cache } = setup();
    await use(page('A'));
    create.mockImplementationOnce(() => { throw Error('capacity'); });
    expect(await use(page('B'))).toBe(0);
    expect(close).toHaveBeenCalledOnce();
    expect(cache.diagnostics).toMatchObject({ hosts: 0, capacityRefusals: 1, fallbacks: 1 });
    expect(await use(page('B'))).toBe(2);
  });

  it('unexpected reservation failure is not silently treated as a capacity fallback', async () => {
    const { use, create } = setup(); create.mockImplementationOnce(() => { throw Error('broken allocator'); });
    await expect(use(page('A'))).rejects.toThrow('broken allocator');
  });

  it('uses the requested output-mode fallback after capacity refusal', async () => {
    const { cache, create, closeFallback } = setup();
    create.mockImplementationOnce(() => { throw Error('capacity'); });
    let finish!: () => void;
    const gpuFallback = { id: 99, size: 0 };
    const work = cache.use({ ...page('A'), texture: true }, 200, () => true,
      async slot => { expect(slot).toBe(gpuFallback); await new Promise<void>(r => { finish = r }); }, gpuFallback);
    cache.clear(); expect(closeFallback).not.toHaveBeenCalled();
    finish(); await work; expect(closeFallback).toHaveBeenCalledOnce();
  });

  it('project retirement drains a busy host before releasing its memory exactly once', async () => {
    const { cache, close, use } = setup();
    let finish!: () => void;
    const work = cache.use(page('A'), 200, () => true, () => new Promise<void>(r => { finish = r; }));
    cache.clear(); cache.clear();
    expect(close).not.toHaveBeenCalled();
    await expect(use(page('B'))).rejects.toThrow('remain serial');
    finish(); await work;
    expect(close).toHaveBeenCalledOnce(); expect(cache.diagnostics.hosts).toBe(0);
    expect(await use(page('A'))).toBe(2); // cannot resurrect old workspace page
  });

  it('retirement also waits for a busy legacy fallback', async () => {
    const { cache, create, closeFallback } = setup();
    create.mockImplementationOnce(() => { throw Error('capacity'); });
    let finish!: () => void;
    const work = cache.use(page('A'), 200, () => true, () => new Promise<void>(r => { finish = r; }));
    closeFallback.mockClear(); cache.clear();
    expect(closeFallback).not.toHaveBeenCalled();
    finish(); await work; expect(closeFallback).toHaveBeenCalledOnce();
  });

  it('cancellation before admission allocates nothing, and failed work never keeps a busy lease', async () => {
    const { cache, create, use, close } = setup();
    await expect(cache.use(page('A'), 200, () => false, async () => 1)).rejects.toThrow();
    expect(create).not.toHaveBeenCalled();
    await expect(cache.use(page('A'), 200, () => true, async () => { throw Error('capture'); })).rejects.toThrow('capture');
    expect(await use(page('A'))).toBe(1);
    cache.clear(); expect(close).toHaveBeenCalledOnce();
  });
});
