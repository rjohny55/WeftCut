# Experimental resident Motif export pages

Set `WEFTCUT_EXPORT_MOTIF_HOSTS=8` to request up to eight resident capture pages.
Valid whole limits are 1–12; unset or invalid values preserve the default three.
This changes residency, not execution: at most two page clocks run concurrently,
and producer credits remain the existing 3/2/1 plans. Preview is unchanged.

Preflight caps the ceiling at peak simultaneous distinct package/props/size/fps
identities and reserves resident memory separately from working capture buffers.
Reduced-memory plans decrease residency. Main accepts only the owner-scoped
admitted plan; lazy page creation still borrows its native memory lease. If
another page cannot be admitted, existing pages are reused. Cancellation retires
the pool but lets active operations settle before returning their leases.

The corresponding local Linux/AMD integration measurement exported a 120-second
multilayer range at 1080p30, H.264 8 Mbps and AAC stereo. Three-host GPU bridge:
881.961 s; eight-host generic LRU: 627.309 s. This is one sequential pair in a
custom integration build, not a measured result from an upstream installer or
this port alone. The final-compositor bridge and GPU Motif selection are separate
prerequisites. Detailed sanitized tables accompany issue #62.

The larger cache is opt-in. RAM admission is not whole-GPU VRAM admission;
authored textures/FBOs and Chromium may allocate outside these estimates. The
1080p experiment does not establish 4K safety on an 8 GiB GPU. GPU-process-reset
recovery for every resident source surface remains a known pre-existing gap.

## Document-aware reuse

The opt-in cache first uses an exact props affinity, then admits a new resident
if allowed. Only when selecting a victim does it prefer an idle page with the
same package/revision/dimensions/fps/transport before generic LRU. This avoids
re-navigation between packages when many props variants exceed the ceiling.
Busy pages are never reused. The default three-host victim policy is unchanged.
The fixed-size pool counter `documentReuses` records the choice.

In the same local integration range, this reduced page loads from 709 to 240
and elapsed time from 627.309 to 457.043 s, with the same eight-host / 5,501 MiB
admitted plan and 17,218 full-resolution GPU captures. Relative to the earlier
three-host bridge control (881.961 s), elapsed time fell 48.18%, equivalent to
1.93× throughput. These are not additive percentages with the earlier bridge
experiment. No full-length hardware timing of this upstream port is claimed.

All 3,600 decoded timestamps matched the serial control. 3,477 frames were
pixel-identical; YUV PSNR 98.34 dB, mean 8×8 luma block SSIM 0.9999999837.
The largest-difference frame was also inspected without a visible loss.
These compare lossy outputs, not a lossless-source reference.

Changing props reruns authored setup and absolute-time rendering. Setup must
dispose its previous DOM/Three.js resources; the host does not generically clean
up arbitrary user content. A→B→A content-state/VRAM regression testing and wider
GPU/platform validation remain necessary before enabling this by default.
