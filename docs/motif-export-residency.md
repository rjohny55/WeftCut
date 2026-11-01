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
