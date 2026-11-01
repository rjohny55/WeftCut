/** Narrow qualification: never reinterpret software, 10-bit, CRF or VBV intent. */
export interface GpuExportArgs {
  width: number;
  height: number;
  fpsNum: number;
  fpsDen: number;
  codec: string;
  pixFmt: string;
  bitrate: number;
  cbr: boolean;
  gop: number;
  software: boolean;
  outputPath: string;
  finalizationToken?: string;
  crf?: number;
  maxBitrate?: number;
  bufferSize?: number;
}
export function gpuExportEligible(args: GpuExportArgs): boolean {
  return (
    ["h264", "hevc"].includes(args.codec) &&
    args.pixFmt === "yuv420p" &&
    !args.software &&
    !args.cbr &&
    args.crf == null &&
    args.maxBitrate == null &&
    args.bufferSize == null &&
    [args.width, args.height].every(
      (n) => Number.isSafeInteger(n) && n >= 16 && n <= 4096 && n % 2 === 0,
    ) &&
    [args.fpsNum, args.fpsDen, args.bitrate, args.gop].every(
      (n) => Number.isSafeInteger(n) && n > 0,
    ) &&
    args.fpsNum / args.fpsDen <= 120
  );
}
export function amdRenderDevice(
  device: string,
  vendor: string,
  activeVendors: number[],
  renderer = "",
): boolean {
  const hardwareAmd =
    /\b(?:AMD|ATI|Radeon)\b/i.test(renderer) &&
    !/swiftshader|llvmpipe|softpipe|software/i.test(renderer);
  return (
    /^\/dev\/dri\/renderD\d+$/.test(device) &&
    vendor.trim().toLowerCase() === "0x1002" &&
    hardwareAmd &&
    activeVendors.every((id) => id === 0 || id === 0x1002)
  );
}
export const GPU_EXPORT_FAILURE = "GPU_FINAL_EXPORT_FAILED";
