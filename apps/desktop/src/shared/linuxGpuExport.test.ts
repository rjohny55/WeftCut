import { describe, it, expect } from "vitest";
import {
  amdRenderDevice,
  gpuExportEligible,
  type GpuExportArgs,
} from "./linuxGpuExport";
const args: GpuExportArgs = {
  width: 1920,
  height: 1080,
  fpsNum: 30,
  fpsDen: 1,
  codec: "h264",
  pixFmt: "yuv420p",
  bitrate: 8000000,
  cbr: false,
  gop: 30,
  software: false,
  outputPath: "/tmp/test.mp4",
};
describe("final GPU export qualification", () => {
  it("accepts bounded native SDR delivery codecs", () => {
    expect(gpuExportEligible(args)).toBe(true);
    expect(gpuExportEligible({ ...args, codec: "hevc" })).toBe(true);
  });
  it.each([
    { software: true },
    { pixFmt: "yuv420p10le" },
    { codec: "av1" },
    { codec: "prores" },
    { cbr: true },
    { crf: 20 },
    { maxBitrate: 9000000 },
    { bufferSize: 20000000 },
    { width: 1919 },
    { height: 4320 },
    { fpsDen: 0 },
    { bitrate: NaN },
    { fpsNum: 1000 },
  ])("preserves previous encoder intent %j", (change) => {
    expect(gpuExportEligible({ ...args, ...change })).toBe(false);
  });
  it("requires the render node and active renderer both to be AMD", () => {
    expect(
      amdRenderDevice(
        "/dev/dri/renderD129",
        "0x1002\n",
        [0x1002],
        "AMD Radeon RX 5700 XT",
      ),
    ).toBe(true);
    expect(amdRenderDevice("/dev/dri/renderD129", "0x1002\n", [0x1002])).toBe(
      false,
    );
    for (const [node, vendor, active] of [
      ["/dev/dri/renderD128", "0x10de", [0x10de]],
      ["/dev/dri/renderD128", "0x1002", [0x10de]],
      ["/dev/dri/renderD128", "0x1002", []],
      ["/dev/dri/renderD128", "0x1002", [0x1002, 0x10de]],
      ["/tmp/device", "0x1002", [0x1002]],
    ] as const)
      expect(amdRenderDevice(node, vendor, [...active])).toBe(false);
  });
  it("accepts a proven AMD ANGLE renderer when Wayland reports PCI vendor zero", () => {
    expect(
      amdRenderDevice(
        "/dev/dri/renderD128",
        "0x1002",
        [0],
        "ANGLE (AMD, Radeon RX 5700 XT)",
      ),
    ).toBe(true);
    expect(
      amdRenderDevice(
        "/dev/dri/renderD128",
        "0x1002",
        [0],
        "llvmpipe (AMD software)",
      ),
    ).toBe(false);
    expect(
      amdRenderDevice(
        "/dev/dri/renderD128",
        "0x1002",
        [0],
        "ANGLE (NVIDIA, RTX 4090)",
      ),
    ).toBe(false);
  });
});
