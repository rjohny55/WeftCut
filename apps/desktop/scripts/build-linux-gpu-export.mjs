// Optional N-API sink; absence is a supported runtime fallback, not app failure.
import { existsSync, mkdtempSync, cpSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { linuxSysroot, LINUX_TRIPLE } from "./napi-linux-sysroot.mjs";
import { glibcViolations } from "./glibc-floor.mjs";

if (process.platform !== "linux") process.exit(0);
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const sdk = process.env.FFMPEG_DIR || join(root, "resources/ffmpeg-lgpl/linux");
const headers = [
  process.env.NODE_API_INCLUDE,
  join(dirname(process.execPath), "../include/node"),
  "/usr/local/include/node",
  "/usr/include/node",
].find((p) => p && existsSync(join(p, "node_api.h")));
if (!headers) throw Error("Install Node N-API headers or set NODE_API_INCLUDE");
const sysroot = linuxSysroot();
const cross = sysroot.env[`CXX_${LINUX_TRIPLE.replaceAll("-", "_")}`];
const compiler = process.env.CXX || cross || "g++";
const output = join(root, "native/decode/linux-gpu-export.node");
const lib = join(sdk, "lib");
// Never put the host's /usr/include ahead of a release cross-sysroot's libc.
const stage = mkdtempSync(join(tmpdir(), "weftcut-gpu-headers-"));
cpSync(
  join(process.env.VA_INCLUDE || "/usr/include", "va"),
  join(stage, "va"),
  { recursive: true },
);
cpSync(
  join(process.env.JSON_INCLUDE || "/usr/include", "nlohmann"),
  join(stage, "nlohmann"),
  { recursive: true },
);
const args = [
  "-std=c++17",
  "-O2",
  "-shared",
  "-fPIC",
  join(root, "native/gpu-export/session.cpp"),
  "-I" + headers,
  "-I" + join(sdk, "include"),
  "-I" + stage,
  "-L" + lib,
  "-lavformat",
  "-lavcodec",
  "-lavutil",
  "-lswscale",
  join(lib, "libva.so.2"),
  "-Wl,--disable-new-dtags",
  "-Wl,-rpath,$ORIGIN",
  "-Wl,-rpath-link," + lib,
  "-o",
  output,
];
try {
  execFileSync(compiler, args, { stdio: "inherit" });
} finally {
  rmSync(stage, { recursive: true, force: true });
}
if (sysroot.args) {
  const violations = glibcViolations(
    execFileSync("objdump", ["-T", output], { encoding: "utf8" }),
  ).filter((s) => !/^napi_\w+ is a strong unversioned import$/.test(s));
  if (violations.length)
    throw Error("GPU export glibc floor: " + violations.join("; "));
}
console.log("Built optional Linux GPU export sink: " + output);
