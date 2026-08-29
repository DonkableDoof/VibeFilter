const { contextBridge, ipcRenderer, webUtils } = require("electron");

contextBridge.exposeInMainWorld("vf", {
  // Library persistence
  loadLibrary: () => ipcRenderer.invoke("library:load"),
  saveLibrary: (data) => ipcRenderer.invoke("library:save", data),

  // Adding files
  pickFiles: () => ipcRenderer.invoke("files:pick"),
  processFiles: (paths) => ipcRenderer.invoke("files:process", paths),

  // Cover bank
  bankList: () => ipcRenderer.invoke("bank:list"),
  bankAdd: () => ipcRenderer.invoke("bank:add"),
  bankDelete: (id) => ipcRenderer.invoke("bank:delete", id),

  // Resolve a dropped File object to its real disk path (Electron 30+)
  pathForFile: (file) => {
    try {
      return webUtils.getPathForFile(file);
    } catch {
      return file.path || null;
    }
  },

  // Drag a track out into Premiere / Finder / Explorer
  startDrag: (filePath, iconDataUrl) => ipcRenderer.send("drag:start", filePath, iconDataUrl),

  // Reveal in Finder/Explorer
  reveal: (filePath) => ipcRenderer.send("file:reveal", filePath),

  // Open a URL in the default browser
  openUrl: (url) => ipcRenderer.send("url:open", url),

  // Change the window icon to match the chosen accent theme
  setIcon: (accentName) => ipcRenderer.send("icon:set", accentName),

  // Build a playable/displayable URL for a local file
  fileUrl: (filePath) => `vfile://${encodeURIComponent(filePath)}`,
});
