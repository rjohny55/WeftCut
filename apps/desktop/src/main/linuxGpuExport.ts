import {
  app,
  BrowserWindow,
  ipcMain,
  MessageChannelMain,
  type WebContents,
} from "electron";
import { createRequire } from "node:module";
import { constants, tmpdir } from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { OffscreenFrames } from "./motif/offscreenFrames";
import { GPU_EXPORT_HOST } from "./linuxGpuExportHost";
import {
  amdRenderDevice,
  gpuExportEligible,
  GPU_EXPORT_FAILURE,
  type GpuExportArgs,
} from "../shared/linuxGpuExport";
import { markInternalWindow, hardenWindow } from "./windows";
import { resolveExportFinalization } from "./resourceIpc";
import { reserveResources } from "./resources";

type Sink = {
  start(args: string): string;
  frame(args: string): Promise<string>;
  finish(): string;
  cancel(): string;
  verify(file: string, refs: Buffer[], w: number, h: number): string;
};
type Job = {
  owner: number;
  token: string;
  args: GpuExportArgs;
  device: string;
  key: string;
  index: number;
  win: BrowserWindow;
  frames: OffscreenFrames;
  release: () => void;
  offOwner?: () => void;
  inflight?: Promise<unknown>;
  closing?: Promise<void>;
  closed: boolean;
};
let sink: Sink | undefined,
  job: Job | undefined,
  starting = false,
  generation = 0;
const verdicts = new Map<string, boolean>();
const failedDevices = new Set<string>();
const verdictKey = (device: string, args: GpuExportArgs) =>
  `${generation}:${device}:${args.codec}:${args.width}x${args.height}:${args.fpsNum}/${args.fpsDen}:${args.bitrate}:${args.gop}`;
function addon(): Sink {
  if (sink) return sink;
  const require_ = createRequire(import.meta.url),
    original = process.dlopen;
  try {
    process.dlopen = (module, filename, flags) =>
      original.call(
        process,
        module,
        filename,
        (flags ?? 0) |
          constants.dlopen.RTLD_NOW |
          constants.dlopen.RTLD_LOCAL |
          constants.dlopen.RTLD_DEEPBIND,
      );
    return (sink = require_(
      path.join(
        path.dirname(require_.resolve("@weftcut/native-decode")),
        "linux-gpu-export.node",
      ),
    ) as Sink);
  } finally {
    process.dlopen = original;
  }
}
function bounded<T>(work: Promise<T>, ms: number, reason: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([
    work,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(Error(reason)), ms);
    }),
  ]).finally(() => clearTimeout(timer!));
}
function cleanup(active: Job): Promise<void> {
  if (active.closing) return active.closing;
  active.closed = true;
  return (active.closing = Promise.resolve().then(async () => {
    // Retain the source lease until the native async VPP/encoder work completes.
    try {
      await active.inflight;
    } catch {
      /* failure is reported by consume */
    }
    if (job === active) {
      sink?.cancel();
      job = undefined;
    }
    active.offOwner?.();
    active.frames.dispose();
    if (!active.win.isDestroyed()) active.win.destroy();
    active.release();
  }));
}
async function open(
  owner: WebContents,
  args: GpuExportArgs,
  device: string,
  key: string,
  parent?: number,
): Promise<Job> {
  const native = addon(); // Absence must not consume any of the old sink's admission.
  // The admitted native export parent already owns its CPU phase. Borrow only
  // memory: returning a child intentionally does not replenish plan threads.
  // Spending even one here would make a later standard-sink fallback impossible.
  // Match the planner's standard native-sink envelope (videosink.rs), including
  // probe references, surface pools and decoder/VPP overhead.
  const release = reserveResources(
    parent === undefined ? 1 : 0,
    128 + Math.ceil((args.width * args.height * 32) / 1048576),
    parent,
  );
  let win: BrowserWindow | undefined;
  try {
    native.start(JSON.stringify({ ...args, device }));
    win = new BrowserWindow({
      show: false,
      width: args.width,
      height: args.height,
      useContentSize: true,
      transparent: true,
      webPreferences: {
        preload: path.join(import.meta.dirname, "../preload/gpuExportHost.js"),
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        backgroundThrottling: false,
        offscreen: { useSharedTexture: true },
      },
    });
    markInternalWindow(win);
    hardenWindow(win, { allowExternalOpen: false });
    win.webContents.setFrameRate(120);
    const active: Job = {
      owner: owner.id,
      args,
      device,
      key,
      index: 0,
      token: randomUUID(),
      win,
      frames: new OffscreenFrames(win.webContents),
      release,
      closed: false,
    };
    job = active;
    await bounded(
      win.loadURL(
        "data:text/html;charset=utf-8," + encodeURIComponent(GPU_EXPORT_HOST),
      ),
      10000,
      "GPU host startup timeout",
    );
    return active;
  } catch (error) {
    if (win && !win.isDestroyed()) win.destroy();
    sink?.cancel();
    job = undefined;
    release();
    throw error;
  }
}
async function consume(active: Job, index: number) {
  if (active.closed || job !== active || index !== active.index)
    throw Error("GPU frame sequence mismatch");
  const texture = await active.frames.capture(
    active.args.width,
    active.args.height,
    () =>
      bounded(
        active.win.webContents.capturePage(),
        3000,
        "GPU surface fence timeout",
      ),
  );
  try {
    const info = texture.textureInfo,
      pixmap = info.handle.nativePixmap;
    if (
      !pixmap ||
      pixmap.planes.length !== 1 ||
      info.visibleRect.x ||
      info.visibleRect.y ||
      info.visibleRect.width !== active.args.width ||
      info.visibleRect.height !== active.args.height ||
      !["rgba", "bgra"].includes(info.pixelFormat)
    )
      throw Error("Unsupported export texture");
    const pending = addon().frame(
      JSON.stringify({
        index,
        width: active.args.width,
        height: active.args.height,
        pixelFormat: info.pixelFormat,
        modifier: pixmap.modifier,
        ...pixmap.planes[0],
      }),
    );
    active.inflight = pending;
    await pending;
    if (active.closed) throw Error("GPU export closed");
    active.index++;
  } finally {
    active.inflight = undefined;
    texture.release();
  }
}
async function probe(
  owner: WebContents,
  args: GpuExportArgs,
  device: string,
  key: string,
  parent?: number,
): Promise<boolean> {
  const probeFile = path.join(
    tmpdir(),
    `weftcut-export-${randomUUID()}-gpu-probe.mp4`,
  );
  let active: Job | undefined;
  try {
    active = await open(
      owner,
      { ...args, outputPath: probeFile },
      device,
      key,
      parent,
    );
    const refs: Buffer[] = [];
    for (let n = 0; n < 3; n++) {
      await bounded(
        active.win.webContents.executeJavaScript(
          `window.__gpuProbe(${n},${args.width},${args.height})`,
        ),
        4000,
        "GPU probe draw timeout",
      );
      refs.push(
        (
          await bounded(
            active.win.webContents.capturePage(),
            3000,
            "GPU probe reference timeout",
          )
        ).toBitmap(),
      );
      await consume(active, n);
    }
    addon().finish();
    const result = JSON.parse(
      addon().verify(probeFile, refs, args.width, args.height),
    ) as { quality: boolean; frames: number; rgbRmse: number[] };
    console.info(
      "[gpu-final-export] probe",
      JSON.stringify({ device, codec: args.codec, ...result }),
    );
    return result.quality && result.frames === 3;
  } catch (error) {
    if (String(error).includes("resource-capacity-exceeded")) throw error;
    console.warn("[gpu-final-export] probe declined:", String(error));
    return false;
  } finally {
    if (active) await cleanup(active);
    await fs.rm(probeFile, { force: true }).catch(() => {});
  }
}
async function amdDevice(owner: WebContents): Promise<string | null> {
  const explicit = process.env.WEFTCUT_VAAPI_DEVICE;
  if (explicit && !/^\/dev\/dri\/renderD\d+$/.test(explicit)) return null;
  try {
    const info = (await app.getGPUInfo("complete")) as {
      gpuDevice?: { vendorId: number; deviceId?: number; active?: boolean }[];
      auxAttributes?: { glRenderer?: string };
    };
    const devices = info.gpuDevice ?? [],
      active = devices.filter((d) => d.active);
    const names = explicit
      ? [path.basename(explicit)]
      : (await fs.readdir("/sys/class/drm")).filter((name) =>
          /^renderD\d+$/.test(name),
        );
    let nodes: string[] = [];
    for (const name of names) {
      if (
        (await fs.readFile(`/sys/class/drm/${name}/device/vendor`, "utf8"))
          .trim()
          .toLowerCase() === "0x1002"
      )
        nodes.push(name);
    }
    if (nodes.length > 1 && active.length === 1 && active[0]?.deviceId) {
      const deviceId = active[0].deviceId;
      const matches = await Promise.all(
        nodes.map(async (name) => ({
          name,
          id: Number(
            (
              await fs.readFile(`/sys/class/drm/${name}/device/device`, "utf8")
            ).trim(),
          ),
        })),
      );
      nodes = matches
        .filter((node) => node.id === deviceId)
        .map((node) => node.name);
    }
    if (nodes.length !== 1) return null;
    const device = "/dev/dri/" + nodes[0],
      vendor = "0x1002";
    const vendors = (active.length ? active : devices).map((d) => d.vendorId);
    let renderer = info.auxAttributes?.glRenderer ?? "";
    if (!renderer)
      renderer = String(
        await bounded(
          owner.executeJavaScript(
            `(()=>{const c=document.createElement('canvas');c.width=1;c.height=1;const gl=c.getContext('webgl2');if(!gl)return '';const ext=gl.getExtension('WEBGL_debug_renderer_info');const result=ext?gl.getParameter(ext.UNMASKED_RENDERER_WEBGL):'';gl.getExtension('WEBGL_lose_context')?.loseContext();return result;})()`,
          ),
          3000,
          "GPU identity timeout",
        ),
      );
    const qualified = amdRenderDevice(device, vendor, vendors, renderer);
    if (!qualified)
      console.info(
        "[gpu-final-export] device declined",
        JSON.stringify({ device, vendor: vendor.trim(), vendors, renderer }),
      );
    return qualified ? device : null;
  } catch (error) {
    console.info("[gpu-final-export] AMD device unavailable:", String(error));
    return null;
  }
}
export function gpuExportEncoder(output: string) {
  return job && !job.closed && job.args.outputPath === output
    ? {
        encoder: job.args.codec + "_vaapi",
        device: "gpu" as const,
        utilization_percent: null,
      }
    : null;
}

if (process.platform === "linux") {
  app.on("child-process-gone", (_event, details) => {
    if (details.type === "GPU") {
      generation++;
      verdicts.clear();
      failedDevices.clear();
      if (job) void cleanup(job);
    }
  });
  app.on("before-quit", () => {
    if (job) void cleanup(job);
  });
  ipcMain.handle("gpu-export:start", async (event, args: GpuExportArgs) => {
    if (event.senderFrame !== event.sender.mainFrame)
      throw Error("GPU export requires main frame");
    if (
      process.env.WEFTCUT_GPU_FINAL_EXPORT !== "1" ||
      !gpuExportEligible(args)
    )
      return null;
    // Resizing/10-bit are excluded by the caller and by worker validation too.
    const device = await amdDevice(event.sender);
    if (!device || failedDevices.has(device)) return null;
    if (starting || job) throw Error("GPU export already active");
    starting = true;
    const key = verdictKey(device, args);
    try {
      const parent = resolveExportFinalization(
        event.sender.id,
        args.finalizationToken,
      );
      if (
        !args.finalizationToken ||
        path.dirname(args.outputPath) !== path.resolve(tmpdir()) ||
        !/^weftcut-export-[\w-]+-video\.mp4$/.test(
          path.basename(args.outputPath),
        )
      )
        return null;
      if (!verdicts.has(key))
        verdicts.set(key, await probe(event.sender, args, device, key, parent));
      if (!verdicts.get(key) || key !== verdictKey(device, args)) return null;
      const active = await open(event.sender, args, device, key, parent),
        channel = new MessageChannelMain();
      active.win.webContents.postMessage(
        "gpu-export:port",
        { token: active.token },
        [channel.port2],
      );
      event.sender.postMessage("gpu-export:port", { token: active.token }, [
        channel.port1,
      ]);
      const close = () => {
        if (job === active) void cleanup(active);
      };
      event.sender.once("destroyed", close);
      event.sender.once("render-process-gone", close);
      active.offOwner = () => {
        event.sender.removeListener("destroyed", close);
        event.sender.removeListener("render-process-gone", close);
      };
      console.info(
        "[gpu-final-export] selected",
        JSON.stringify({
          device,
          codec: args.codec,
          width: args.width,
          height: args.height,
        }),
      );
      return { token: active.token };
    } catch (error) {
      if (job) await cleanup(job);
      if (String(error).includes("resource-capacity-exceeded")) throw error;
      verdicts.set(key, false);
      console.warn(
        "[gpu-final-export] retaining previous sink:",
        String(error),
      );
      return null;
    } finally {
      starting = false;
    }
  });
  const hostJob = (event: Electron.IpcMainInvokeEvent, index: number) => {
    const active = job;
    if (
      !active ||
      event.sender !== active.win.webContents ||
      event.senderFrame !== event.sender.mainFrame ||
      index !== active.index
    )
      throw Error("Unowned GPU frame");
    return active;
  };
  ipcMain.handle("gpu-export:prepare", (event, index: number) => {
    const active = hostJob(event, index);
    return { width: active.args.width, height: active.args.height };
  });
  ipcMain.handle("gpu-export:consume", async (event, index: number) => {
    const active = hostJob(event, index);
    try {
      await consume(active, index);
    } catch (error) {
      if (active.closed) throw Error("GPU export cancelled");
      verdicts.set(active.key, false);
      failedDevices.add(active.device);
      throw Error(GPU_EXPORT_FAILURE + ": " + String(error));
    }
  });
  ipcMain.handle("gpu-export:finish", async (event) => {
    const active = job;
    if (!active || event.sender.id !== active.owner)
      throw Error("Unowned GPU export");
    try {
      const result = JSON.parse(addon().finish());
      console.info("[gpu-final-export] complete", JSON.stringify(result));
      return result;
    } catch (error) {
      verdicts.set(active.key, false);
      failedDevices.add(active.device);
      throw Error(GPU_EXPORT_FAILURE + ": " + String(error));
    } finally {
      await cleanup(active);
    }
  });
  ipcMain.handle("gpu-export:cancel", async (event) => {
    if (job) {
      if (event.sender.id !== job.owner) throw Error("Unowned GPU cancel");
      await cleanup(job);
    }
  });
  ipcMain.handle("gpu-export:disable", async (event) => {
    if (job) {
      if (event.sender.id !== job.owner) throw Error("Unowned GPU disable");
      verdicts.set(job.key, false);
      failedDevices.add(job.device);
      await cleanup(job);
    }
  });
}
