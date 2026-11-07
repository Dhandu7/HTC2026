// Minimal, explicit bridge between the overlay page and the Electron main process.
const { contextBridge, ipcRenderer } = require("electron");

const shortcut = process.platform === "darwin" ? "⌘⇧G" : "Ctrl+Shift+G";

contextBridge.exposeInMainWorld("gazetype", {
  shortcut,
  setExpanded: (expanded) => ipcRenderer.send("set-expanded", !!expanded),
  setClickable: (clickable) => ipcRenderer.send("set-clickable", !!clickable),
  insertText: (text) => ipcRenderer.invoke("insert-text", String(text)),
  onVisibility: (cb) => ipcRenderer.on("visibility", (_e, v) => cb(!!v)),
});
