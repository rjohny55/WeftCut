import { contextBridge, ipcRenderer } from "electron";
contextBridge.exposeInMainWorld("gpuFrame", {
  prepare: (index: number) => ipcRenderer.invoke("gpu-export:prepare", index),
  consume: (index: number) => ipcRenderer.invoke("gpu-export:consume", index),
});
ipcRenderer.on("gpu-export:port", (event, data) =>
  window.postMessage(
    { type: "gpu-export-port", token: data.token },
    "*",
    event.ports,
  ),
);
