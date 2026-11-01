import { beforeEach, describe, expect, it, vi } from "vitest";
const mock = vi.hoisted(() => ({
  handlers: new Map<string, (...args: any[]) => any>(),
  events: new Map<string, (...args: any[]) => void>(),
  windows: [] as any[],
  quality: true,
  throwFrame: false,
  release: vi.fn(),
  textureRelease: vi.fn(),
  start: vi.fn(),
  finish: vi.fn(),
  cancel: vi.fn(),
  verify: vi.fn(),
  frame: vi.fn(),
  vendor: "0x1002",
}));
vi.mock("electron", () => ({
  app: {
    on: (name: string, cb: any) => mock.events.set(name, cb),
    getGPUInfo: async () => ({
      gpuDevice: [{ vendorId: 0x1002, active: true }],
    }),
  },
  ipcMain: { handle: (name: string, cb: any) => mock.handlers.set(name, cb) },
  BrowserWindow: class {
    webContents: any;
    constructor() {
      const mainFrame = {};
      this.webContents = {
        id: 100 + mock.windows.length,
        mainFrame,
        setFrameRate: vi.fn(),
        executeJavaScript: async () => {},
        capturePage: async () => ({
          toBitmap: () => Buffer.alloc(32 * 16 * 4),
        }),
        postMessage: vi.fn(),
      };
      mock.windows.push(this);
    }
    loadURL = async () => {};
    destroy = vi.fn();
    isDestroyed = () => false;
  },
  MessageChannelMain: class {
    port1 = {};
    port2 = {};
  },
}));
vi.mock("node:module", () => ({
  createRequire: () =>
    Object.assign(
      () => ({
        start: mock.start,
        frame: mock.frame,
        finish: mock.finish,
        cancel: mock.cancel,
        verify: mock.verify,
      }),
      { resolve: () => "/native/index.js" },
    ),
}));
vi.mock("node:fs/promises", () => ({
  default: {
    readFile: async () => mock.vendor,
    readdir: async () => ["renderD128"],
    rm: async () => {},
  },
}));
vi.mock("./windows", () => ({
  markInternalWindow: vi.fn(),
  hardenWindow: vi.fn(),
}));
vi.mock("./resourceIpc", () => ({ resolveExportFinalization: () => 7 }));
vi.mock("./resources", () => ({ reserveResources: () => mock.release }));
vi.mock("./motif/offscreenFrames", () => ({
  OffscreenFrames: class {
    dispose = vi.fn();
    capture = async () => ({
      release: mock.textureRelease,
      textureInfo: {
        pixelFormat: "bgra",
        visibleRect: { x: 0, y: 0, width: 32, height: 16 },
        handle: {
          nativePixmap: {
            modifier: "0",
            planes: [{ fd: 9, stride: 128, offset: 0, size: 2048 }],
          },
        },
      },
    });
  },
}));
const args = {
  width: 32,
  height: 16,
  fpsNum: 30,
  fpsDen: 1,
  codec: "h264",
  pixFmt: "yuv420p",
  bitrate: 8000000,
  cbr: false,
  gop: 30,
  software: false,
  outputPath: "/tmp/weftcut-export-example-video.mp4",
  finalizationToken: "token",
};
const owner = () => {
  const sender = {
    id: 77,
    mainFrame: {},
    postMessage: vi.fn(),
    once: vi.fn(),
    removeListener: vi.fn(),
    executeJavaScript: async () => "ANGLE (AMD, Radeon RX 5700 XT)",
  };
  return { sender, senderFrame: sender.mainFrame };
};
beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  mock.handlers.clear();
  mock.events.clear();
  mock.windows = [];
  mock.quality = true;
  mock.throwFrame = false;
  mock.vendor = "0x1002";
  process.env.WEFTCUT_GPU_FINAL_EXPORT = "1";
  mock.start.mockReturnValue("{}");
  mock.frame.mockImplementation(async () => {
    if (mock.throwFrame) throw Error("driver rejected surface");
    return "{}";
  });
  mock.finish.mockReturnValue('{"frames":3,"bytes":100,"elapsedMs":1}');
  mock.cancel.mockReturnValue("{}");
  mock.verify.mockImplementation(() =>
    JSON.stringify({ quality: mock.quality, frames: 3, rgbRmse: [1, 1, 1] }),
  );
  await import("./linuxGpuExport");
});
const start = (event = owner()) =>
  mock.handlers.get("gpu-export:start")!(event, args);
describe.skipIf(process.platform !== "linux")(
  "Linux AMD final sink lifecycle",
  () => {
    it("keeps the established sink by default until explicitly opted in", async () => {
      delete process.env.WEFTCUT_GPU_FINAL_EXPORT;
      expect(await start()).toBeNull();
      expect(mock.start).not.toHaveBeenCalled();
    });
    it("qualifies all three encoded frames before selecting and caches the verdict", async () => {
      const event = owner();
      expect(await start(event)).toHaveProperty("token");
      expect(mock.frame).toHaveBeenCalledTimes(3);
      expect(mock.verify).toHaveBeenCalledTimes(1);
      await mock.handlers.get("gpu-export:finish")!(event);
      expect(mock.release).toHaveBeenCalledTimes(2);
      expect(event.sender.removeListener).toHaveBeenCalledTimes(2);
      expect(await start(event)).toHaveProperty("token");
      expect(mock.verify).toHaveBeenCalledTimes(1);
      await mock.handlers.get("gpu-export:cancel")!(event);
    });
    it("retains the old path on failed quality, and never opens a real sink", async () => {
      mock.quality = false;
      expect(await start()).toBeNull();
      expect(mock.start).toHaveBeenCalledTimes(1);
      expect(mock.textureRelease).toHaveBeenCalledTimes(3);
      expect(mock.release).toHaveBeenCalledTimes(1);
      expect(await start()).toBeNull();
      expect(mock.verify).toHaveBeenCalledTimes(1);
    });
    it("does not load native code for NVIDIA or explicit disable", async () => {
      mock.vendor = "0x10de";
      expect(await start()).toBeNull();
      mock.vendor = "0x1002";
      process.env.WEFTCUT_GPU_FINAL_EXPORT = "0";
      expect(await start()).toBeNull();
      expect(mock.start).not.toHaveBeenCalled();
    });
    it("disables failed transport for the rest of the GPU generation", async () => {
      const event = owner();
      await start(event);
      mock.throwFrame = true;
      const wc = mock.windows.at(-1).webContents;
      await expect(
        mock.handlers.get("gpu-export:consume")!(
          { sender: wc, senderFrame: wc.mainFrame },
          0,
        ),
      ).rejects.toThrow("GPU_FINAL_EXPORT_FAILED");
      await mock.handlers.get("gpu-export:disable")!(event);
      expect(await start(event)).toBeNull();
      expect(mock.textureRelease).toHaveBeenCalledTimes(4);
    });
    it("drains an in-flight frame on cancellation without poisoning the GPU verdict", async () => {
      const event = owner();
      await start(event);
      let complete: ((value: string) => void) | undefined;
      mock.frame.mockImplementationOnce(
        () =>
          new Promise<string>((resolve) => {
            complete = resolve;
          }),
      );
      const wc = mock.windows.at(-1).webContents;
      const pending = mock.handlers.get("gpu-export:consume")!(
        { sender: wc, senderFrame: wc.mainFrame },
        0,
      );
      const rejected = expect(pending).rejects.toThrow("GPU export cancelled");
      await vi.waitFor(() => expect(complete).toBeTypeOf("function"));
      const cancel = mock.handlers.get("gpu-export:cancel")!(event);
      complete!("{}");
      await Promise.all([cancel, rejected]);
      expect(await start(event)).toHaveProperty("token");
      expect(mock.verify).toHaveBeenCalledTimes(1);
      await mock.handlers.get("gpu-export:cancel")!(event);
    });
    it("rejects a different renderer and an out-of-order frame", async () => {
      const event = owner();
      await start(event);
      const wc = mock.windows.at(-1).webContents;
      expect(() => mock.handlers.get("gpu-export:prepare")!(event, 0)).toThrow(
        "Unowned",
      );
      expect(() =>
        mock.handlers.get("gpu-export:prepare")!(
          { sender: wc, senderFrame: wc.mainFrame },
          1,
        ),
      ).toThrow("Unowned");
      await expect(
        mock.handlers.get("gpu-export:cancel")!({
          ...event,
          sender: { ...event.sender, id: 999 },
        }),
      ).rejects.toThrow("Unowned");
      await mock.handlers.get("gpu-export:cancel")!(event);
    });
  },
);
