# Optional Linux AMD final-frame encoder

`session.cpp` is an N-API addon packaged as
`native/decode/linux-gpu-export.node`, beside the existing LGPL FFmpeg/libva
runtime. It does not modify host drivers. Missing/unsupported builds leave the
previous sink available.

After staging the shared runtime with `npm run napi:build:decode`, build with
`npm run napi:build:gpu`. Alternatively, `WEFTCUT_BUILD_LINUX_GPU_EXPORT=1 npm run
napi:build:decode` builds both addons. The standard build does not require this
experimental module or additional headers. Linux build prerequisites:
`libva-dev`, `nlohmann-json3-dev`, a C++17 compiler and Node N-API headers.
`NODE_API_INCLUDE`, `VA_INCLUDE`, `JSON_INCLUDE`, and `FFMPEG_DIR` can locate
explicit SDKs. Default release builds reuse the napi Linux cross-toolchain;
`WEFTCUT_NATIVE_BUILD=1` is the existing host-native development opt-in.

The main-process loader uses RTLD_DEEPBIND against Electron's libffmpeg symbol
interposition. The addon keeps `$ORIGIN` RPATH for the co-located shared runtime.
The normal desktop package wildcard includes the addon. Its presence alone
does not change export selection; the main/renderer integration must qualify
the device, image quality and resource admission before using it. Missing
addons leave the existing native export sink available.
