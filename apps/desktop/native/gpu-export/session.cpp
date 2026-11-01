// Optional Linux sink. Source DMA-BUF stays leased until VPP copies into an
// encoder-owned NV12 slot. No CPU pixel buffers on the export frame path.
#include <node_api.h>
extern "C" {
#include <libavcodec/avcodec.h>
#include <libavformat/avformat.h>
#include <libavutil/hwcontext.h>
#include <libavutil/hwcontext_vaapi.h>
#include <libavutil/opt.h>
#include <libswscale/swscale.h>
#include <va/va.h>
#include <va/va_drmcommon.h>
#include <va/va_vpp.h>
}
#include <chrono>
#include <cmath>
#include <memory>
#include <nlohmann/json.hpp>
#include <stdexcept>
#include <vector>
using json = nlohmann::json;
static double now() {
  return std::chrono::duration<double, std::milli>(
             std::chrono::steady_clock::now().time_since_epoch())
      .count();
}
static void vaok(VAStatus r, const char *s) {
  if (r)
    throw std::runtime_error(std::string(s) + ": " + vaErrorStr(r));
}
static void avok(int r, const char *s) {
  if (r < 0) {
    char msg[256];
    av_strerror(r, msg, sizeof msg);
    throw std::runtime_error(std::string(s) + ": " + msg);
  }
}
struct Session {
  AVBufferRef *device = nullptr, *pool = nullptr;
  AVCodecContext *enc = nullptr;
  AVFormatContext *mux = nullptr;
  AVPacket *packet = av_packet_alloc();
  VADisplay display = nullptr;
  VAConfigID config = VA_INVALID_ID;
  VAContextID context = VA_INVALID_ID;
  AVStream *stream = nullptr;
  int width = 0, height = 0, count = 0, packets = 0;
  bool finished = false, busy = false;
  double began = now(), importMs = 0, vppMs = 0, encodeMs = 0;
  ~Session() {
    avcodec_free_context(&enc);
    av_packet_free(&packet);
    if (display) {
      if (context != VA_INVALID_ID)
        vaDestroyContext(display, context);
      if (config != VA_INVALID_ID)
        vaDestroyConfig(display, config);
    }
    av_buffer_unref(&pool);
    if (mux) {
      if (mux->pb)
        avio_closep(&mux->pb);
      avformat_free_context(mux);
    }
    av_buffer_unref(&device);
  }
  Session() = default;
  void init(const json &j) {
    if (!packet)
      throw std::bad_alloc();
    width = j.at("width");
    height = j.at("height");
    if (width < 16 || height < 16 || width > 4096 || height > 4096 ||
        width % 2 || height % 2)
      throw std::runtime_error("Only bounded even SDR8 dimensions qualified");
    if (j.at("pixFmt") != "yuv420p" || j.value("software", false) ||
        j.value("cbr", false) || j.contains("maxBitrate") ||
        j.contains("bufferSize"))
      throw std::runtime_error(
          "QA sink supports uncapped ABR SDR420 hardware only");
    std::string codec = j.at("codec");
    if (codec != "h264" && codec != "hevc")
      throw std::runtime_error("Only H264/HEVC supported");
    const std::string devicePath = j.at("device");
    avok(av_hwdevice_ctx_create(&device, AV_HWDEVICE_TYPE_VAAPI,
                                devicePath.c_str(), nullptr, 0),
         "VAAPI device");
    display =
        ((AVVAAPIDeviceContext *)((AVHWDeviceContext *)device->data)->hwctx)
            ->display;
    pool = av_hwframe_ctx_alloc(device);
    if (!pool)
      throw std::bad_alloc();
    auto *frames = (AVHWFramesContext *)pool->data;
    frames->format = AV_PIX_FMT_VAAPI;
    frames->sw_format = AV_PIX_FMT_NV12;
    frames->width = width;
    frames->height = height;
    frames->initial_pool_size = 4;
    avok(av_hwframe_ctx_init(pool), "NV12 pool");
    vaok(vaCreateConfig(display, VAProfileNone, VAEntrypointVideoProc, nullptr,
                        0, &config),
         "VPP config");
    vaok(vaCreateContext(display, config, width, height, VA_PROGRESSIVE,
                         nullptr, 0, &context),
         "VPP context");
    const AVCodec *encoder = avcodec_find_encoder_by_name(
        codec == "h264" ? "h264_vaapi" : "hevc_vaapi");
    if (!encoder)
      throw std::runtime_error("VAAPI encoder unavailable");
    enc = avcodec_alloc_context3(encoder);
    if (!enc)
      throw std::bad_alloc();
    enc->width = width;
    enc->height = height;
    enc->pix_fmt = AV_PIX_FMT_VAAPI;
    enc->time_base = {j.at("fpsDen"), j.at("fpsNum")};
    enc->framerate = {j.at("fpsNum"), j.at("fpsDen")};
    enc->bit_rate = j.at("bitrate");
    enc->gop_size = j.at("gop");
    enc->max_b_frames = 0;
    enc->hw_frames_ctx = av_buffer_ref(pool);
    enc->sample_aspect_ratio = {1, 1};
    enc->colorspace = AVCOL_SPC_BT709;
    enc->color_range = AVCOL_RANGE_MPEG;
    enc->color_primaries = AVCOL_PRI_BT709;
    enc->color_trc = AVCOL_TRC_BT709;
    std::string output = j.at("outputPath");
    if (output.find("weftcut-export-") == std::string::npos ||
        output.find("..") != std::string::npos)
      throw std::runtime_error("Output must be an export temp file");
    avok(avformat_alloc_output_context2(&mux, nullptr, "mp4", output.c_str()),
         "MP4 context");
    if (mux->oformat->flags & AVFMT_GLOBALHEADER)
      enc->flags |= AV_CODEC_FLAG_GLOBAL_HEADER;
    avok(avcodec_open2(enc, encoder, nullptr), "VAAPI encoder open");
    stream = avformat_new_stream(mux, nullptr);
    stream->time_base = enc->time_base;
    stream->avg_frame_rate = enc->framerate;
    avok(avcodec_parameters_from_context(stream->codecpar, enc),
         "stream parameters");
    avok(avio_open(&mux->pb, output.c_str(), AVIO_FLAG_WRITE), "MP4 open");
    avok(avformat_write_header(mux, nullptr), "MP4 header");
  }
  void drain() {
    for (;;) {
      int r = avcodec_receive_packet(enc, packet);
      if (r == AVERROR(EAGAIN) || r == AVERROR_EOF)
        return;
      avok(r, "receive packet");
      if (!packet->duration)
        packet->duration = 1;
      av_packet_rescale_ts(packet, enc->time_base, stream->time_base);
      packet->stream_index = stream->index;
      avok(av_interleaved_write_frame(mux, packet), "MP4 write");
      av_packet_unref(packet);
      packets++;
    }
  }
  void frame(const json &j) {
    if (finished || j.at("index") != count || j.at("width") != width ||
        j.at("height") != height)
      throw std::runtime_error("Frame sequence or dimensions mismatch");
    const std::string format = j.at("pixelFormat");
    if (format != "bgra" && format != "rgba")
      throw std::runtime_error("Unexpected surface format");
    const double t = now();
    VADRMPRIMESurfaceDescriptor d{};
    d.fourcc = format == "bgra" ? VA_FOURCC_BGRA : VA_FOURCC_RGBA;
    d.width = width;
    d.height = height;
    d.num_objects = 1;
    d.objects[0].fd = j.at("fd");
    d.objects[0].size = j.at("size");
    d.objects[0].drm_format_modifier =
        std::stoull(j.at("modifier").get<std::string>());
    d.num_layers = 1;
    d.layers[0].drm_format = format == "bgra" ? 0x34325241 : 0x34324241;
    d.layers[0].num_planes = 1;
    d.layers[0].pitch[0] = j.at("stride");
    d.layers[0].offset[0] = j.at("offset");
    VASurfaceAttrib a[2]{};
    a[0].type = VASurfaceAttribMemoryType;
    a[0].flags = VA_SURFACE_ATTRIB_SETTABLE;
    a[0].value.type = VAGenericValueTypeInteger;
    a[0].value.value.i = VA_SURFACE_ATTRIB_MEM_TYPE_DRM_PRIME_2;
    a[1].type = VASurfaceAttribExternalBufferDescriptor;
    a[1].flags = VA_SURFACE_ATTRIB_SETTABLE;
    a[1].value.type = VAGenericValueTypePointer;
    a[1].value.value.p = &d;
    VASurfaceID source = VA_INVALID_ID;
    AVFrame *dst = av_frame_alloc();
    if (!dst)
      throw std::bad_alloc();
    VABufferID buffer = VA_INVALID_ID;
    try {
      vaok(vaCreateSurfaces(display, VA_RT_FORMAT_RGB32, width, height, &source,
                            1, a, 2),
           "DMA-BUF import");
      importMs += now() - t;
      avok(av_hwframe_get_buffer(pool, dst, 0), "NV12 target");
      VAProcPipelineParameterBuffer params{};
      params.surface = source;
      params.surface_color_standard = VAProcColorStandardBT709;
      params.output_color_standard = VAProcColorStandardBT709;
      const double vt = now();
      vaok(vaCreateBuffer(display, context, VAProcPipelineParameterBufferType,
                          sizeof params, 1, &params, &buffer),
           "VPP params");
      vaok(vaBeginPicture(display, context,
                          (VASurfaceID)(uintptr_t)dst->data[3]),
           "VPP begin");
      vaok(vaRenderPicture(display, context, &buffer, 1), "VPP render");
      vaok(vaEndPicture(display, context), "VPP end");
      vaok(vaSyncSurface(display, (VASurfaceID)(uintptr_t)dst->data[3]),
           "VPP fence");
      vppMs += now() - vt;
      // Source lease can end after this fence: encoder owns a separate NV12
      // pool slot.
      const double et = now();
      dst->pts = count;
      dst->colorspace = AVCOL_SPC_BT709;
      dst->color_range = AVCOL_RANGE_MPEG;
      avok(avcodec_send_frame(enc, dst), "VAAPI encode");
      drain();
      encodeMs += now() - et;
      count++;
    } catch (...) {
      if (buffer != VA_INVALID_ID)
        vaDestroyBuffer(display, buffer);
      if (source != VA_INVALID_ID)
        vaDestroySurfaces(display, &source, 1);
      av_frame_free(&dst);
      throw;
    }
    vaDestroyBuffer(display, buffer);
    vaDestroySurfaces(display, &source, 1);
    av_frame_free(&dst);
  }
  json finish() {
    avok(avcodec_send_frame(enc, nullptr), "encoder flush");
    drain();
    avok(av_write_trailer(mux), "MP4 trailer");
    avio_flush(mux->pb);
    finished = true;
    return json({{"frames", count},
                 {"packets", packets},
                 {"bytes", avio_tell(mux->pb)},
                 {"elapsedMs", now() - began},
                 {"importMs", importMs},
                 {"vppMs", vppMs},
                 {"encodeMs", encodeMs},
                 {"cpuPixelBytes", 0}});
  }
};
static std::shared_ptr<Session> session;
static json arg(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value v;
  napi_get_cb_info(env, info, &argc, &v, nullptr, nullptr);
  if (!argc)
    throw std::runtime_error("JSON argument required");
  size_t size;
  napi_get_value_string_utf8(env, v, nullptr, 0, &size);
  std::string str(size + 1, '\0');
  napi_get_value_string_utf8(env, v, str.data(), str.size(), &size);
  str.resize(size);
  return json::parse(str);
}
static napi_value value(napi_env e, const json &j) {
  auto s = j.dump();
  napi_value v;
  napi_create_string_utf8(e, s.c_str(), s.size(), &v);
  return v;
}
static napi_value start(napi_env e, napi_callback_info i) {
  try {
    if (session)
      throw std::runtime_error("GPU sink already active");
    auto candidate = std::make_shared<Session>();
    candidate->init(arg(e, i));
    session = candidate;
    return value(e, {{"ready", true}});
  } catch (std::exception &x) {
    napi_throw_error(e, nullptr, x.what());
    return nullptr;
  }
}
struct FrameWork {
  std::shared_ptr<Session> owner;
  json args;
  std::string error;
  napi_async_work work;
  napi_deferred deferred;
};
static napi_value frame(napi_env e, napi_callback_info i) {
  try {
    if (!session || session->busy)
      throw std::runtime_error("No idle GPU sink");
    auto item = std::make_unique<FrameWork>();
    item->owner = session;
    item->args = arg(e, i);
    napi_value promise, name;
    napi_create_promise(e, &item->deferred, &promise);
    napi_create_string_utf8(e, "GPU export frame", NAPI_AUTO_LENGTH, &name);
    auto execute = [](napi_env, void *data) {
      auto *x = static_cast<FrameWork *>(data);
      try {
        x->owner->frame(x->args);
      } catch (const std::exception &err) {
        x->error = err.what();
      }
    };
    auto complete = [](napi_env env, napi_status status, void *data) {
      auto *x = static_cast<FrameWork *>(data);
      x->owner->busy = false;
      if (status != napi_ok || !x->error.empty()) {
        napi_value msg, err;
        napi_create_string_utf8(
            env, x->error.empty() ? "GPU frame cancelled" : x->error.c_str(),
            NAPI_AUTO_LENGTH, &msg);
        napi_create_error(env, nullptr, msg, &err);
        napi_reject_deferred(env, x->deferred, err);
      } else
        napi_resolve_deferred(env, x->deferred,
                              value(env, {{"frames", x->owner->count}}));
      napi_delete_async_work(env, x->work);
      delete x;
    };
    if (napi_create_async_work(e, nullptr, name, execute, complete, item.get(),
                               &item->work) != napi_ok)
      throw std::runtime_error("Cannot allocate GPU frame work");
    session->busy = true;
    if (napi_queue_async_work(e, item->work) != napi_ok) {
      session->busy = false;
      napi_delete_async_work(e, item->work);
      throw std::runtime_error("Cannot queue GPU frame work");
    }
    item.release();
    return promise;
  } catch (std::exception &x) {
    napi_throw_error(e, nullptr, x.what());
    return nullptr;
  }
}
static napi_value finish(napi_env e, napi_callback_info) {
  try {
    if (!session || session->busy)
      throw std::runtime_error("No idle GPU sink");
    auto r = session->finish();
    session.reset();
    return value(e, r);
  } catch (std::exception &x) {
    napi_throw_error(e, nullptr, x.what());
    return nullptr;
  }
}
static napi_value cancel(napi_env e, napi_callback_info) {
  session.reset();
  return value(e, {{"cancelled", true}});
}
// Probe-only readback: compare each decoded test frame with a lossless BGRA
// reference, rejecting stale frames, colour errors and unavailable decoders.
static napi_value verify(napi_env env, napi_callback_info info) {
  AVFormatContext *input = nullptr;
  AVCodecContext *decoder = nullptr;
  AVFrame *decoded = av_frame_alloc();
  AVPacket *packet = av_packet_alloc();
  SwsContext *scale = nullptr;
  auto cleanup = [&]() {
    sws_freeContext(scale);
    av_packet_free(&packet);
    av_frame_free(&decoded);
    avcodec_free_context(&decoder);
    avformat_close_input(&input);
  };
  try {
    size_t argc = 4;
    napi_value values[4];
    napi_get_cb_info(env, info, &argc, values, nullptr, nullptr);
    if (argc != 4)
      throw std::runtime_error(
          "Probe requires path, references, width, height");
    size_t len;
    napi_get_value_string_utf8(env, values[0], nullptr, 0, &len);
    std::string path(len + 1, '\0');
    napi_get_value_string_utf8(env, values[0], path.data(), path.size(), &len);
    path.resize(len);
    int32_t width, height;
    napi_get_value_int32(env, values[2], &width);
    napi_get_value_int32(env, values[3], &height);
    if (width < 16 || height < 16 || width > 4096 || height > 4096)
      throw std::runtime_error("Invalid probe size");
    uint32_t count;
    napi_get_array_length(env, values[1], &count);
    if (count != 3)
      throw std::runtime_error("Three references required");
    std::vector<const uint8_t *> refs;
    for (uint32_t i = 0; i < count; i++) {
      napi_value ref;
      napi_get_element(env, values[1], i, &ref);
      void *data;
      size_t size;
      if (napi_get_buffer_info(env, ref, &data, &size) != napi_ok ||
          size != size_t(width) * height * 4)
        throw std::runtime_error("Invalid BGRA reference");
      refs.push_back(static_cast<const uint8_t *>(data));
    }
    avok(avformat_open_input(&input, path.c_str(), nullptr, nullptr),
         "probe open");
    avok(avformat_find_stream_info(input, nullptr), "probe info");
    int index =
        av_find_best_stream(input, AVMEDIA_TYPE_VIDEO, -1, -1, nullptr, 0);
    avok(index, "probe video");
    auto *par = input->streams[index]->codecpar;
    decoder = avcodec_alloc_context3(avcodec_find_decoder(par->codec_id));
    avok(avcodec_parameters_to_context(decoder, par), "probe params");
    decoder->thread_count = 1;
    avok(avcodec_open2(decoder, decoder->codec, nullptr), "probe decoder");
    std::vector<uint8_t> rgb(size_t(width) * height * 4);
    json errors = json::array();
    bool quality = true;
    unsigned frames = 0;
    auto receive = [&]() {
      for (;;) {
        int r = avcodec_receive_frame(decoder, decoded);
        if (r == AVERROR(EAGAIN) || r == AVERROR_EOF)
          return;
        avok(r, "probe decode");
        if (frames >= refs.size() || decoded->width != width ||
            decoded->height != height)
          throw std::runtime_error("Probe frame count or size mismatch");
        scale = sws_getCachedContext(
            scale, width, height, (AVPixelFormat)decoded->format, width, height,
            AV_PIX_FMT_BGRA, SWS_BILINEAR, nullptr, nullptr, nullptr);
        if (!scale)
          throw std::runtime_error("Probe colour converter unavailable");
        const int *coeff = sws_getCoefficients(SWS_CS_ITU709);
        sws_setColorspaceDetails(scale, coeff, 0, coeff, 1, 0, 1 << 16,
                                 1 << 16);
        uint8_t *planes[] = {rgb.data(), nullptr, nullptr, nullptr};
        int strides[] = {width * 4, 0, 0, 0};
        sws_scale(scale, decoded->data, decoded->linesize, 0, height, planes,
                  strides);
        long double sse = 0;
        for (size_t p = 0; p < rgb.size(); p++)
          if (p % 4 != 3) {
            int d = int(rgb[p]) - int(refs[frames][p]);
            sse += d * d;
          }
        double rmse = sqrt(double(sse / (size_t(width) * height * 3)));
        errors.push_back(rmse);
        quality = quality && std::isfinite(rmse) && rmse <= 5.0;
        frames++;
      }
    };
    while (av_read_frame(input, packet) >= 0) {
      if (packet->stream_index == index) {
        avok(avcodec_send_packet(decoder, packet), "probe packet");
        receive();
      }
      av_packet_unref(packet);
    }
    avok(avcodec_send_packet(decoder, nullptr), "probe flush");
    receive();
    quality = quality && frames == count;
    cleanup();
    return value(
        env, {{"quality", quality}, {"frames", frames}, {"rgbRmse", errors}});
  } catch (const std::exception &x) {
    cleanup();
    napi_throw_error(env, nullptr, x.what());
    return nullptr;
  }
}
NAPI_MODULE_INIT() {
  napi_property_descriptor p[] = {
      {"start", 0, start, 0, 0, 0, napi_default, 0},
      {"frame", 0, frame, 0, 0, 0, napi_default, 0},
      {"finish", 0, finish, 0, 0, 0, napi_default, 0},
      {"cancel", 0, cancel, 0, 0, 0, napi_default, 0},
      {"verify", 0, verify, 0, 0, 0, napi_default, 0}};
  napi_define_properties(env, exports, 5, p);
  return exports;
}
