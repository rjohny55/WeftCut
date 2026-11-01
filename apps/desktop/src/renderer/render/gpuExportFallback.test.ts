import { describe, it, expect, vi } from "vitest";
import { withGpuExportFallback } from "./gpuExportFallback";
import { GPU_EXPORT_FAILURE } from "../../shared/linuxGpuExport";
describe("GPU sink fallback", () => {
  it("keeps successful export", async () => {
    const restart = vi.fn();
    expect(
      await withGpuExportFallback(
        async () => 42,
        restart,
        () => true,
        () => false,
      ),
    ).toBe(42);
    expect(restart).not.toHaveBeenCalled();
  });
  it("restarts once from frame zero after a transport failure", async () => {
    const run = vi
        .fn()
        .mockRejectedValueOnce(Error(GPU_EXPORT_FAILURE))
        .mockResolvedValue(42),
      restart = vi.fn();
    expect(
      await withGpuExportFallback(
        run,
        restart,
        () => true,
        () => false,
      ),
    ).toBe(42);
    expect(run).toHaveBeenCalledTimes(2);
    expect(restart).toHaveBeenCalledTimes(1);
  });
  it("does not retry a failing fallback again", async () => {
    const run = vi.fn().mockRejectedValue(Error(GPU_EXPORT_FAILURE)),
      restart = vi.fn();
    await expect(
      withGpuExportFallback(
        run,
        restart,
        () => true,
        () => false,
      ),
    ).rejects.toThrow(GPU_EXPORT_FAILURE);
    expect(run).toHaveBeenCalledTimes(2);
    expect(restart).toHaveBeenCalledTimes(1);
  });
  it("does not confuse a source filename with a transport error tag", async () => {
    const restart = vi.fn();
    await expect(
      withGpuExportFallback(
        async () => {
          throw Error("Missing media: " + GPU_EXPORT_FAILURE + ".mp4");
        },
        restart,
        () => true,
        () => false,
      ),
    ).rejects.toThrow("Missing media");
    expect(restart).not.toHaveBeenCalled();
  });
  it.each([
    { active: true, cancelled: true, error: GPU_EXPORT_FAILURE },
    { active: false, cancelled: false, error: GPU_EXPORT_FAILURE },
    { active: true, cancelled: false, error: "source media missing" },
    { active: true, cancelled: false, error: "resource-capacity-exceeded" },
  ])("does not hide cancellation/content/resource errors %j", async (s) => {
    const restart = vi.fn();
    await expect(
      withGpuExportFallback(
        async () => {
          throw Error(s.error);
        },
        restart,
        () => s.active,
        () => s.cancelled,
      ),
    ).rejects.toThrow(s.error);
    expect(restart).not.toHaveBeenCalled();
  });
});
