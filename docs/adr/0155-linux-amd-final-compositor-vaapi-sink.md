---
status: accepted
---

# Linux AMD final-compositor VA-API sink

The native encoder may consume the final compositor through an independent
ImageBitmap → offscreen shared texture → DMA-BUF → VA-API VPP/encoder path.
This is final-frame encoding, not the separate Motif delivery probe (0148).
The editor UI is never captured. The source surface is retained until VPP's
copy completes; the encoder owns an independent bounded NV12 pool. Driver
frame work runs off the Electron main thread. Only the initial surface fence
and the isolated qualification test read CPU pixels.

## Selection and fallback

Only Linux with a proven hardware AMD WebGL renderer and an AMD DRM render node
qualifies. Wayland may report PCI vendor 0; the actual WebGL renderer string,
not the existence of a GPU alone, supplies the missing evidence. Software GL,
NVIDIA, Intel, Windows and macOS retain the previous path. Device choice respects
`WEFTCUT_VAAPI_DEVICE`. Upstream selection is experimental and opt-in:
`WEFTCUT_GPU_FINAL_EXPORT=1` enables qualification. With no opt-in the established
sink is unchanged, even on an AMD device. The custom application's earlier
automatic selection is not proposed as the upstream default.

Initial support is native-size SDR 8-bit H.264/HEVC, uncapped VBR. Scaling,
10-bit, AV1, intermediates, software/CRF and explicit VBV/CBR retain the old
encoder without reinterpreting any setting. The optional addon uses the existing
LGPL shared runtime and is packaged beside native-decode. A missing addon is a
supported fallback.

Before the first eligible export, an isolated test at the requested size and
codec encodes three changing frames, including text, gradients and RGB patches.
Software decoding compares every RGB pixel against lossless references; all
three frames must exist and each RGB RMSE must be ≤5/255. Qualification is local,
session-only, cached per device/size/codec/fps/bitrate/GOP, and invalidated on GPU replacement.
The native resource authority owns test/export memory and thread admission.
The parent native-export plan keeps its CPU-phase reservation until finalization;
the GPU child borrows only memory. Child release deliberately does not replenish
plan threads, so consuming one in a probe would break later old-sink fallback.

Failed qualification retains the old sink. A transport/encoder failure disables
the path and retries the immutable range exactly once from frame zero through
the previous native sink. Encoded bitstreams are never spliced mid-file.
Cancellation, missing media and resource refusal are not transport fallbacks.
Only the completed output is published through the existing finalization flow.
UI telemetry identifies the actual VA-API encoder; unknown utilization stays
unknown rather than inventing a percentage.

## Evidence

RX 5700 XT, Linux/Wayland, ANGLE/OpenGL, 1080p30: both exports of a 120-second
multilayer section completed with 3600 frames and AAC stereo. Full-frame CPU
comparison of the decoded files found no PTS mismatch, YUV PSNR 49.23 dB,
non-overlapping 8×8 luma block SSIM 0.99658, and mean Y/U/V differences under
0.56 code values. Contact sheets and the largest-difference transition were
visually inspected without a material quality loss. This is comparison against
the old encoded output, not a lossless source-quality score or a universal claim.

Wall times were 1131.030 s and 866.124 s. The first run overlapped brief diagnostic
work, so the approximately 23% reduction is exploratory, not a precise guaranteed
speedup. Most remaining time was Motif source preparation, not native encoding.
