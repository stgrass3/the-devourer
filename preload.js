const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('devourer', {
  shredFile: (targetId, options) => ipcRenderer.invoke('shred-file', targetId, options),
  getStartupSecureMode: () => ipcRenderer.invoke('get-startup-secure-mode'),
  requestSecureMode: (mode) => ipcRenderer.invoke('request-secure-mode', mode),
  pickFile: () => ipcRenderer.invoke('pick-file'),
  resolvePath: (filename) => ipcRenderer.invoke('resolve-path', filename),
  closeWindow: () => ipcRenderer.send('close-window'),
  minimizeWindow: () => ipcRenderer.send('minimize-window'),
  onProgress: (cb) => {
    const listener = (_e, p) => cb(p);
    ipcRenderer.on('shred-progress', listener);
    return () => ipcRenderer.removeListener('shred-progress', listener);
  },
  // Electron 32+ removed File.path. Use webUtils.getPathForFile in the preload
  // bridge, then register the path in main. The renderer only receives a
  // short-lived target ID, never a raw filesystem path.
  registerDroppedFile: (file) => {
    try {
      const filePath = webUtils.getPathForFile(file) || '';
      if (!filePath) return Promise.resolve(null);
      return ipcRenderer.invoke('register-dropped-file', filePath);
    } catch (_) {
      return Promise.resolve(null);
    }
  },
});
