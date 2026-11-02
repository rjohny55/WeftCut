# Linux/AMD preview follow-up

Measured on RX 5700 XT, native Wayland, ANGLE hardware GL, Electron 44.9.3.
The project is 1920×1080 at 30 fps, with animated Motifs and a VP8 screen recording.
These are sequential real-editor tests of our custom 0.5.6 integration, not a
claim that stock upstream main already has these results. Export measurements
previously posted in issue #62 are separate; percentages must not be added.

## Animated Motifs: bounded GPU capture overlap

Both controls use the same bundle, original preview quality, GPU Motif helper,
software video relay disabled and an eight-page maximum. The changed setting is
`WEFTCUT_PREVIEW_MOTIF_OVERLAP=0` versus `2`. Playback interval: 180–195 s.

| Run | Timeline span | Completed texture captures | Page loads | Capture failures | Late ticks | Decode drops |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Serial, cold | 15.000 s | 133 | 6 | 0 | 35 | 0 |
| Overlap, cold | 14.967 s | 215 | 8 | 0 | 42 | 0 |
| Serial, warm | 15.000 s | 144 | 0 | 0 | 34 | 0 |
| Overlap, warm | 14.967 s | 255 | 0 | 0 | 39 | 0 |

Warm completed captures increased **77.1%**, cold **61.7%**. These are aggregate
capture counts across layers, **not presented FPS**. Although the ceiling was
eight in both runs, actual retained pages increased six→eight. This combines
overlap and a larger active working set, not an isolated concurrency-only gain.

On the two main moving layers, warm unique bound-frame identities increased
46→135 and 92→184; their maximum sampled frame holds fell 689→274 ms and
785→275 ms. Another layer's worst hold worsened 862→917 ms. Late ticks also
increased: the experiment improves delivery but does not establish uniformly
smooth 30 fps. Process-tree memory increased 2213→2420 MiB; native reserved
memory increased 1004→1374 MiB. This is not total VRAM measurement.

Candidate-only longer coverage advanced 120.000 s with 2048 texture captures,
zero capture failures, zero decode drops and 201 late ticks. One animated frame
held for 1.53 s. No serial 120 s counterpart was run, so this is coverage, not
another speedup percentage.

Settled real-project 180→360→180 captures matched exactly in all 1920×1080 RGBA
channels. Nineteen synthetic GPU frames matched expected RGBA, including alpha,
two native RAFs, concurrent clocks, props and revisions. A twentieth request
crossing project replacement was correctly rejected as superseded. Native memory
leases and receiver-completion barriers remain active. Capacity refusal disables
overlap and returns through the exclusive queue; the upstream proposal is opt-in.

## Screen recording: original versus existing 720p quick proxy

The original is VP8 1923×1269; its seek may require decoding from PTS zero.
The native continuation fix prevents a moving nearby target from repeatedly
restarting that reference prefix. It skips pixel packing for reference-only
frames but preserves cancellation/generation checks and ordinary export decode.

The existing quick proxy is H.264 1092×720, short six-frame GOP, CRF 30. It uses
the existing explicit per-media Proxy preference, not an automatic quality drop.
A terminal WebCodecs failure after some output used to leave playback frozen;
the recovery patch permits one software retry even after those first frames.
Export keeps the previous first-frame-only fallback policy.

Same rebuilt integration, real UI Play/Pause over timeline 360–375 s:

| Actual preview source | Clock span | Observed bound-PTS changes | Late ticks | Decode drops |
| --- | ---: | ---: | ---: | ---: |
| VP8 original / Standard software NV12 | 15.033 s | 273 | 59 | 7 |
| Existing H.264 720p quick proxy / Lite recovered software | 14.967 s | 441 | 0 | 0 |

Bound-PTS change rate increased about **62%**. This is not physical FPS and not
a GPU-only improvement: source resolution, GOP and decoder differ. Geometry and
colors were preserved on visual review, but fine text is softer in the proxy.
Export continues to read its original source. Audio-clock skew at the end of the
proxy run was 7.15 ms, a diagnostic rather than a physical lip-sync measurement.

Qualified timecode UI seeks 360→400→360→370→365 settled in **2.28–3.20 s with
the original, versus 0.25–0.47 s with the proxy**, including UI interactions.
The check required the correct source identity and bound PTS within 40 ms of
the requested source time. A rapid 500→280→390 sequence settled on the final
target, not an obsolete frame. No renderer page errors occurred.

Zero late/decode-drop counts apply to that measured **720p proxy** window only.
Original-resolution preview still sometimes drops/stalls. The owner's later
interactive feedback confirms that distinction. Do not describe this as all
video playback or all seeking becoming drop-free.

## Packaged working-desktop smoke

The production bundle was built without E2E hooks and installed on the same
AMD/Wayland desktop. UI Play advanced the real project from 03:00:00 to 03:16:06;
Pause worked. The follow-up drained to 354 started/completed GPU texture captures,
zero capture failures, zero pending/running captures, eight resident hosts and
zero capacity refusals. No renderer JavaScript errors occurred. The UI still
reported late render frames; this is not a zero-lateness claim.

The session's separate synthetic admission probe measured GPU snapshot 30.78 ms
versus PNG 240.40 ms. Those probe medians qualify a transport on this machine;
they are not a whole-project playback-speed ratio. The working profile enables
the GPU helper only after exact-image and speed checks, with PNG fallback.

## Validation and reproducibility

Original integration: 59 native decode tests passed, one packing benchmark
ignored; 118 focused TS tests for the continuation fix; 47 focused recovery
tests; 67 capture/pool/residency tests for overlap. TypeScript and Vite builds
passed. The native decoder was rebuilt and compared byte-for-byte at the target
frame against ordinary decoding. The optional GPU-export C++ build needed VA
headers unavailable in that compiler; it was not represented as a passing build.

The upstream ports are independently checked against `b148801`, separate from
these hardware integration runs; each PR records its own current test results.
They do not change project content, audio, export settings or enable the
experimental transports globally. Windows/macOS and NVIDIA qualification remain
outstanding. No zero-copy/GPU-only or universal 30 fps claim is made.
