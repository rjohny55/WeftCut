# Linux AMD measurements for WeftCut #62

2026-11-01. These are two separate experiments: cached-Motif transport and
final-compositor export. A faster bitmap delivery lane is not the same as a
faster whole-project export.

Hardware: Radeon RX 5700 XT 8 GB; two Xeon E5-2696 v3, 72 logical CPUs;
128 GB host RAM, 24 GiB QA-container limit, no CPU quota. Linux 7.0.0-38,
Mesa 22.3.6, Weston 10.0.1 headless **hardware GL**, ANGLE/OpenGL,
Electron 44.9.3 / Chromium 152.0.7977.167. This is not a Radeon 780M result.
No other heavy benchmark/build was scheduled during the measured series.

## 1. The issue's fair cached-frame transport comparison

Harness: upstream `test/issue-62-fair-transport`, commit `b94cd511`.
Three warm-up rounds, 30 interleaved measured samples per lane/content;
throughput is 45 frames with three requests in flight, without GPU upload.
Full BLAKE3 verification and alpha-weighted box downscale are retained.

The common native runtime is from `ed24929a`; its `motif_frame.rs` differs
from the v0.5.6 implementation only in a comment. The removed legacy
`motifReadFrame` name is adapted to `motifReadFrameScaled(path, 1)` in this
local harness. This is an adapted transport harness, not a stock-installation
or production playback benchmark. The adapter does not skip verification.

All image checks: **21/21, maximum difference 0**. All corrupted frames:
**7/7 rejected**. Windows-only texture lane `e` is skipped on Linux.

### Typical content, 4K input

| Lane | Delivered size | Bitmap-ready p50 / p95 | Page main-thread p50 | Throughput |
|---|---|---:|---:|---:|
| `a@1`, legacy full RGBA IPC + preload bitmap | 3840×2160 | 227.10 / 268.50 ms | 107.99 ms | 9.47 fps |
| `g@1`, utility-process RGBA + renderer worker | 3840×2160 | 346.60 / 374.20 ms | 0.42 ms | 6.93 fps |
| `g@2`, utility-process native half downscale + worker | 1920×1080 | 149.90 / 180.60 ms | 0.24 ms | 16.47 fps |

### Dense content, 4K input

| Lane | Delivered size | Bitmap-ready p50 / p95 | Page main-thread p50 | Throughput |
|---|---|---:|---:|---:|
| `a@1` | 3840×2160 | 284.00 / 334.20 ms | 107.17 ms | 7.83 fps |
| `g@1` | 3840×2160 | 397.10 / 413.40 ms | 0.32 ms | 6.22 fps |
| `g@2` | 1920×1080 | 215.00 / 230.70 ms | 0.26 ms | 11.39 fps |

The utility lane clears the page's main thread. At full resolution its
end-to-end latency/throughput is worse here; halving the delivered dimensions
helps. Do not attribute the half-resolution gain solely to moving work into a
utility process. This does not establish playback late-frame counts.

`uploadMs` is null: the harness did not obtain a WebGPU device for its optional
upload phase. Chromium hardware GL/compositing was enabled. These numbers stop
at bitmap availability; they are not a WebGPU-vs-WebGL or GPU-upload result.

Complete sanitized data: [fair-result.json](fair-result.json),
[fair-thread-result.json](fair-thread-result.json). Traces/profiles stay private.

## 2. Full synthetic export: CPU encoder, existing VA-API, DMA-BUF bridge

Same media-free four-second scene, built-in countdown Motif + animated text,
1920×1080, 30 fps, 120 frames, SDR8 BT.709, H.264, 8 Mbps VBR, GOP 30,
no audio, no scaling. Rendering uses the same GL backend in every row:
**CPU below means software encoding, not an all-software compositor.**

The control app bundle is built from official v0.5.6 `f8195b83`. The candidate
is that same tag plus the AMD addon/integration port, `561b20f7`. Both use
the same native runtime and shared libraries; `export/videosink.rs` is
byte-identical to v0.5.6. This is not a comparison of two untouched official
installers. Existing native-sink encoder/filter threads are 4 in both controls;
this is not a tuned maximum-72-CPU comparison.

One initial job plus five repeated jobs per route, fresh profile and identical
fixture per route, sequential CPU → native → bridge. MCP completion polling
is **1 second**; fine differences below that are not established speedups.

| Route | Initial job | Warm wall median [min–max] | Warm renderer-loop median | Final-frame CPU pixel payload/job |
|---|---:|---:|---:|---:|
| CPU `libx264`, medium | 40.784 s | 10.120 [10.117–10.132] s | 9.111 s | 373,248,000 B (~356 MiB) |
| Existing `h264_vaapi`, CPU PBO/420 → rawvideo → hwupload | 39.749 s | 10.116 [10.108–10.130] s | 9.085 s | 373,248,000 B (~356 MiB) |
| Final ImageBitmap → OSR DMA-BUF → VA-API VPP/encode | 40.705 s | 10.086 [10.071–10.090] s | 9.224 s | 0 steady-state payload bytes |

**No meaningful full-export speedup is demonstrated by this scene.** The
small MCP difference is below the polling resolution; the bridge's renderer
loop is slightly slower, not faster. Most time is source/Motif preparation and
composition. The benefit demonstrated here is eliminating the final-frame
CPU transfer, not accelerating that upstream bottleneck.

This is not zero-copy: VPP makes a GPU-side copy, source Motif work may still
use CPU memory, and startup image qualification/surface fences read CPU pixels.
The final steady-state encoder path does not send a raw frame through RAM.

Selection evidence: all six bridge jobs logged a successful AMD/image probe or
cached verdict, `selected`, and `complete` with 120 frames and
`cpuPixelBytes: 0`. The existing route's process arguments selected
`h264_vaapi`; the CPU bitstream identifies x264, medium, four threads.

### Correctness

- 18/18 files: 4.000 s, 120 frames, 1080p30, YUV420P 8-bit, BT.709, no audio.
- Existing VA-API vs bridge, all 120 decoded frames: YUV PSNR **68.0874 dB**,
  non-overlapping 8×8 luma block SSIM **0.9999971**, zero PTS mismatches.
- CPU vs bridge: PSNR **65.2511 dB**, block SSIM **0.9999915**, zero PTS mismatches.
- A one-second comparison was visually inspected: text, countdown position,
  colour and composited edges match. Metrics compare lossy encoded outputs,
  not the lossless source; the mostly black synthetic background is easy to encode.

Initial Pixman-compositor wiring runs correctly fell back after shared-texture
timeouts. They are excluded from these tables. Hardware GL is required for
the measured shared-texture route. Missing-addon and surface-failure fallbacks
must not be labelled successful GPU acceleration just because a file completed.

All export samples and quality aggregates: [export-results.json](export-results.json).

## Reviewable AMD changes

Apply these in order to upstream `1ad318c4`:

1. [Optional Linux module and explicit build/package wiring](01-optional-linux-vaapi-module.patch).
2. [Opt-in qualification, ownership/cancellation, bounded fallback and fixture](02-qualified-opt-in-final-export.patch).

No workflow changes, server gateway, branding, unrelated editor fixes or user
media are included. The module uses the existing LGPL FFmpeg/libva runtime;
install `libva-dev`, `nlohmann-json3-dev` and Node N-API headers, then run
`npm run napi:build:gpu` after staging native-decode. Runtime opt-in is
`WEFTCUT_GPU_FINAL_EXPORT=1`; default behaviour remains unchanged.

The current-main port passed 31 focused tests, TypeScript checks, native-addon
compilation and Electron/Vite bundle builds. It also completed a six-frame
hardware export. A separate QA-only addon injected a surface error at frame 7;
the current-main renderer restarted the immutable range through the existing
sink and completed all 30 frames. The injected binary is not included here.
The timing comparison above used the v0.5.6 port. Full upstream CI and wider
AMD/platform testing are still pending. Keep the feature experimental; this
report is not grounds for enabling it automatically on every Linux GPU.

## Follow-up: reduce Motif source stalls on a real project

This is a different workload from the four-second synthetic comparison above:
an isolated clone of a real multilayer 120-second project range, 1920×1080,
30 fps / 3,600 frames, H.264 8 Mbps VBR, AAC stereo. Same RX 5700 XT/Linux
machine. The original project/media remained read-only; none are published.
These timings are from the custom integration build, **not a stock upstream
installer or a full-length timing of the separately rebased PR ports**.

| Final-frame route / source-page policy | Wall time | Page loads |
| --- | ---: | ---: |
| GPU bridge, three resident pages | 881.961 s | not recorded |
| GPU bridge, eight resident pages / generic LRU | 627.309 s | 709 |
| GPU bridge, eight resident pages / document-aware reuse | 457.043 s | 240 |

Final elapsed time is **48.18% lower** than the three-host bridge control,
equivalent to **1.93× throughput**. Document-aware reuse alone reduced elapsed
time by 27.14% versus eight-host generic LRU. This is not “48% more throughput,”
and percentages must not be added to the earlier ~23.4% exploratory bridge gain.

For context, that earlier real-project staging-versus-bridge pair measured
1,131.030 → 866.124 s (~23.4% less time); its control briefly overlapped
diagnostic work. The fresh bridge control here is 881.961 s, not 866.124 s.
It is not a new four-way interleaved CPU/old-sink/bridge/cache comparison.
Each full row here is one sequential run, so more alternating repetitions are
needed before treating the percentage as stable or generalizing to other scenes.

Both eight-host runs admitted the same 5,501 MiB memory plan, kept eight resident
pages, at most two executing clocks and the original three producer credits.
They captured exactly 17,218 full-resolution source bitmaps over GPU snapshots:
zero source errors, PNG fallback, utility RGBA payload or final-sink fallback.
This is not whole-editor GPU-only operation; setup, source preparation and
qualification still do CPU work.

The key bottleneck was repeated page navigation, not PNG output: the heavy
section reaches 14 simultaneous props affinities across fewer packages.
Document-aware victim selection preserves exact hits and bounded growth, then
prefers an idle page from the same package/revision/size/fps/transport. Changing
props reruns setup; busy pages are never reused. It does not raise concurrency,
weaken resource admission or downscale export frames.

### Control and quality checks

- Same-bundle 180–183 s subsection: 63.989 s with three residents versus
  17.431 s with eight. All 90 decoded frames and timestamps matched exactly.
- All 3,600 final decoded frames compared against the serial bridge control:
  3,477 pixel-identical, zero PTS mismatches, YUV PSNR **98.34 dB**, mean
  non-overlapping 8×8 luma block SSIM **0.9999999837**. The largest-difference
  frame (output 56.900 s) was visually checked with no visible loss. This is a
  lossy-output comparison, not a lossless-source quality score.
- A separate final-frame lookahead experiment measured 881.961 → 882.052 s:
  **no meaningful gain**; lookahead stays off.
- Cancellation on the overloaded subsection retired the resident pool and
  queued work; the next export completed all 90 frames without source errors.
- A 15-frame HEVC hardware smoke passed. A deliberately injected DMA-BUF error
  retried the entire range through the previous sink and completed 15 H.264
  frames with audio. These are correctness smoke checks, not codec benchmarks.
- The parent independently reran 125 focused tests on the measured integration.
  Upstream-port tests/builds are reported in the respective PRs; wider CI remains
  pending. One startup-race control was excluded because its Motif catalog was
  unavailable and no Motifs rendered; the harness now waits for catalog readiness.

The larger cache remains opt-in (`WEFTCUT_EXPORT_MOTIF_HOSTS=8`, bounded 1–12).
RAM admission is not complete VRAM admission; 4K/8 GiB safety is unproven.
Authored setup must dispose its previous DOM/Three.js resources when props change.
There is also a pre-existing resident-surface invalidation gap after GPU-process
restart; ordinary completion/fallback is not proof of complete restart recovery.
No preview speedup, new PNG-free cached-reader result or default-route change is
claimed. Final output resolution, frame count and the source audio mix were kept
unchanged.

Sanitized aggregate samples and quality measurements:
[residency-results.json](residency-results.json). No user frames, manuscripts,
authored props, project names/paths, media identifiers, traces or credentials
are included.
