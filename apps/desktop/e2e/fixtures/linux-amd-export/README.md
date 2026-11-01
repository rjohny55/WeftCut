# Linux AMD export comparison fixture

Four seconds at 1920×1080 / 30 fps: built-in countdown Motif and animated text.
No media, audio, accounts or external assets. Copy `project.json` to an empty
project directory before opening it; caches and output must not be committed.

Use one GPU/compositor/ANGLE backend, a fresh application profile per route,
identical resource settings and no concurrent benchmark or build. On Linux,
install the Mesa OpenGL and VA-API drivers and expose the same DRM render node
to Chromium and VA-API. The measured bridge used hardware GL on Wayland;
software-only/Pixman compositors did not provide shared textures and correctly
fell back. Keep those runs out of a GPU-bridge performance row.

Build the app and native artifacts first. Start it normally with a dedicated
profile. Enable its local MCP connection; keep `mcp_auth.json` private. Run:

```sh
node apps/desktop/e2e/scripts/linux-amd-export-bench.mjs \
  --auth=/path/to/dedicated-profile/mcp_auth.json \
  --project=/path/to/copied-fixture --route=cpu --out=/path/to/results
```

Repeat with fresh profiles and `--route=native`, then `--route=bridge`:

- CPU: `hw_accel=software`; confirm `libx264` in the encoder log/bitstream.
- Native: launch the app with `WEFTCUT_GPU_FINAL_EXPORT=0`; confirm
  `h264_vaapi` and the existing CPU-readback/rawvideo sink in the log.
- Bridge: launch with `WEFTCUT_GPU_FINAL_EXPORT=1`; require a successful
  `[gpu-final-export] probe`, `selected`, and `complete` for every job. A completed
  file alone does not prove the bridge ran. No selection means fallback, not
  acceleration. CPU-encoder threads are reported, not inferred from host cores.

The script makes one excluded warm-up and five measured jobs; it records MCP
wall time with 100 ms polling. The initial published comparison used the older
local harness with 1 s polling, so its coarse MCP times must not be interpreted
as precise sub-second differences. Renderer PERF SUMMARY and native stage
timings provide a separate, finer-grained view, not the same measurement.

Probe every file for 120 frames, 4 seconds, 1080p30, SDR8 BT.709 and no audio.
Compare decoded full frames and PTS; inspect gradients, text and motion visually.
Encoding is lossy: encoded-file hashes need not match. Keep quality results,
all samples, failed selections, cold and warm timings separate. Do not publish
profiles, traces, auth files, local paths or an unrelated user project.
