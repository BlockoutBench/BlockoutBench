const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('WorkbenchDesktop', {
  isDesktop: true,
  platform: process.platform,
  initState: () => ipcRenderer.invoke('desktop:init-state'),
  openFileDialog: () => ipcRenderer.invoke('desktop:open-file-dialog'),
  openFilePath: filePath => ipcRenderer.invoke('desktop:open-file-path', filePath),
  getRecentFiles: () => ipcRenderer.invoke('desktop:get-recent'),
  clearRecentFiles: () => ipcRenderer.invoke('desktop:clear-recent'),
  saveLibraryItem: item => ipcRenderer.invoke('desktop:save-library-item', item),
  removeLibraryItem: key => ipcRenderer.invoke('desktop:remove-library-item', key),
  clearLibrary: () => ipcRenderer.invoke('desktop:clear-library'),
  setActiveLibraryKey: key => ipcRenderer.invoke('desktop:set-active-key', key),
  reloadWatched: () => ipcRenderer.invoke('desktop:reload-watched'),
  setWatchEnabled: enabled => ipcRenderer.invoke('desktop:set-watch', Boolean(enabled)),
  stopWatch: () => ipcRenderer.invoke('desktop:stop-watch'),
  saveFile: payload => ipcRenderer.invoke('desktop:save-file', payload),
  copyText: text => ipcRenderer.invoke('desktop:copy-text', String(text ?? '')),
  revealFile: target => ipcRenderer.invoke('desktop:reveal-file', target),
  openInEditor: target => ipcRenderer.invoke('desktop:open-editor', target),
  rebuildBuiltins: () => ipcRenderer.invoke('desktop:rebuild-builtins'),
  notifyActiveMap: info => ipcRenderer.send('desktop:active-map', info),
  getPathForFile: file => {
    try {
      return webUtils.getPathForFile(file) || '';
    } catch {
      return '';
    }
  },
  onOpenFile: handler => {
    const fn = (_event, payload) => handler(payload);
    ipcRenderer.on('desktop:open-file', fn);
    return () => ipcRenderer.removeListener('desktop:open-file', fn);
  },
  onFileUpdated: handler => {
    const fn = (_event, payload) => handler(payload);
    ipcRenderer.on('desktop:file-updated', fn);
    return () => ipcRenderer.removeListener('desktop:file-updated', fn);
  },
  onWatchChanged: handler => {
    const fn = (_event, enabled) => handler(enabled);
    ipcRenderer.on('desktop:watch-changed', fn);
    return () => ipcRenderer.removeListener('desktop:watch-changed', fn);
  },
  onRecentChanged: handler => {
    const fn = (_event, list) => handler(list);
    ipcRenderer.on('desktop:recent-changed', fn);
    return () => ipcRenderer.removeListener('desktop:recent-changed', fn);
  },
  onCommand: handler => {
    const fn = (_event, command, arg) => handler(command, arg);
    ipcRenderer.on('desktop:command', fn);
    return () => ipcRenderer.removeListener('desktop:command', fn);
  },
});
