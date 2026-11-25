const { app, BrowserWindow, Menu, dialog, ipcMain, shell, clipboard, screen } = require('electron');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

function ensureWritableUserData() {
  const defaultDir = app.getPath('userData');
  try {
    fs.mkdirSync(defaultDir, { recursive: true });
    const probe = path.join(defaultDir, `.probe-${process.pid}`);
    fs.writeFileSync(probe, '1', 'utf8');
    fs.unlinkSync(probe);
  } catch {
    const fallbackDir = path.join(__dirname, '.user-data');
    try {
      fs.mkdirSync(fallbackDir, { recursive: true });
      const prevState = path.join(defaultDir, 'desktop-state.json');
      const nextState = path.join(fallbackDir, 'desktop-state.json');
      if (!fs.existsSync(nextState) && fs.existsSync(prevState)) {
        fs.copyFileSync(prevState, nextState);
      }
      app.setPath('userData', fallbackDir);
      app.setPath('sessionData', path.join(fallbackDir, 'session'));
    } catch {
      /* ignore */
    }
    app.commandLine.appendSwitch('no-sandbox');
    app.commandLine.appendSwitch('disable-gpu-sandbox');
  }
}
ensureWritableUserData();

const WORKSPACE_ROOT = path.resolve(__dirname, '..');
const INDEX_HTML = path.join(WORKSPACE_ROOT, 'index.html');
const MANIFEST_PATH = path.join(WORKSPACE_ROOT, 'maps', 'manifest.json');
const MAX_RECENT = 10;

let mainWindow = null;
let docWindow = null;
let watcher = null;
let watchDebounce = null;
let watchedPath = null;
let lastWatchedContent = null;
let activeTarget = { key: null, filePath: null, title: '关卡工作台' };
let pendingLaunchFile = findJsonArg(process.argv.slice(1));

const statePath = () => path.join(app.getPath('userData'), 'desktop-state.json');

let store = {
  bounds: { width: 1520, height: 960 },
  maximized: false,
  watchEnabled: true,
  samplesSeeded: false,
  recentFiles: [],
  library: [],
  activeLibraryKey: null,
  lastOpenDir: WORKSPACE_ROOT,
  lastSaveDir: WORKSPACE_ROOT,
};

function readDesktopDefaults() {
  const defaultsPath = path.join(__dirname, 'defaults.json');
  try {
    if (!fs.existsSync(defaultsPath)) return {};
    const raw = JSON.parse(fs.readFileSync(defaultsPath, 'utf8'));
    return raw && typeof raw === 'object' ? raw : {};
  } catch {
    return {};
  }
}

const inlineDir = () => path.join(app.getPath('userData'), 'inline-maps');
const inlineFile = key => path.join(inlineDir(), `${String(key).replace(/[^a-zA-Z0-9_-]/g, '_')}.json`);

function findJsonArg(argv) {
  for (const arg of argv) {
    if (!arg || arg.startsWith('-')) continue;
    const resolved = path.resolve(arg);
    if (/\.json$/i.test(resolved) && fs.existsSync(resolved) && fs.statSync(resolved).isFile()) {
      return resolved;
    }
  }
  return null;
}

function loadStore() {
  try {
    const raw = JSON.parse(fs.readFileSync(statePath(), 'utf8'));
    if (raw && typeof raw === 'object') {
      store = {
        ...store,
        ...raw,
        recentFiles: Array.isArray(raw.recentFiles)
          ? raw.recentFiles.filter(p => typeof p === 'string' && fs.existsSync(p)).slice(0, MAX_RECENT)
          : [],
        library: Array.isArray(raw.library) ? raw.library : [],
        activeLibraryKey: typeof raw.activeLibraryKey === 'string' ? raw.activeLibraryKey : null,
      };
    }
  } catch {
    /* first launch or corrupt state file */
  }
}

function saveStore() {
  try {
    fs.mkdirSync(path.dirname(statePath()), { recursive: true });
    fs.writeFileSync(statePath(), JSON.stringify(store, null, 2), 'utf8');
  } catch {
    /* ignore */
  }
}

function clampBounds(bounds) {
  const b = { width: 1520, height: 960, ...(bounds || {}) };
  b.width = Math.max(960, Number(b.width) || 1520);
  b.height = Math.max(640, Number(b.height) || 960);
  if (Number.isFinite(b.x) && Number.isFinite(b.y)) {
    const display = screen.getDisplayMatching(b);
    const area = display.workArea;
    if (b.x + b.width < area.x + 80 || b.x > area.x + area.width - 80 ||
        b.y + b.height < area.y + 80 || b.y > area.y + area.height - 80) {
      delete b.x;
      delete b.y;
    }
  } else {
    delete b.x;
    delete b.y;
  }
  return b;
}

function readJsonFile(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8');
  return raw.replace(/^\uFEFF/, '');
}

function pushRecent(filePath) {
  const normalized = path.resolve(filePath);
  store.recentFiles = [normalized, ...store.recentFiles.filter(item => item.toLowerCase() !== normalized.toLowerCase())].slice(0, MAX_RECENT);
  store.lastOpenDir = path.dirname(normalized);
  saveStore();
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('desktop:recent-changed', recentItems());
  }
}

function recentItems() {
  return store.recentFiles
    .filter(p => fs.existsSync(p))
    .map(p => ({ filePath: p, fileName: path.basename(p), dir: path.dirname(p) }));
}

function stopWatcher() {
  if (watchDebounce) {
    clearTimeout(watchDebounce);
    watchDebounce = null;
  }
  if (watcher) {
    try { watcher.close(); } catch { /* ignore */ }
    watcher = null;
  }
  watchedPath = null;
  lastWatchedContent = null;
}

function attachWatcher(filePath, initialText) {
  stopWatcher();
  if (!filePath || !fs.existsSync(filePath)) return;
  watchedPath = path.resolve(filePath);
  lastWatchedContent = initialText ?? readJsonFile(watchedPath);
  if (!store.watchEnabled) return;

  const startWatch = () => {
    if (!watchedPath || !store.watchEnabled || !fs.existsSync(watchedPath)) return;
    try {
      watcher = fs.watch(watchedPath, { persistent: false }, eventType => {
        if (watchDebounce) clearTimeout(watchDebounce);
        watchDebounce = setTimeout(() => {
          if (!watchedPath) return;
          if (!fs.existsSync(watchedPath)) {
            setTimeout(() => {
              if (watchedPath && fs.existsSync(watchedPath)) {
                stopWatcherKeepPath(watchedPath);
              }
            }, 120);
            return;
          }
          try {
            const text = readJsonFile(watchedPath);
            if (text !== lastWatchedContent) {
              lastWatchedContent = text;
              if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.webContents.send('desktop:file-updated', {
                  filePath: watchedPath,
                  fileName: path.basename(watchedPath),
                  text,
                });
              }
            }
          } catch {
            /* file may still be mid-write */
          }
          if (eventType === 'rename' && watchedPath && fs.existsSync(watchedPath)) {
            const target = watchedPath;
            stopWatcherKeepPath(target);
          }
        }, 180);
      });
    } catch {
      /* ignore watch errors on unsupported FS */
    }
  };

  const stopWatcherKeepPath = target => {
    const savedContent = lastWatchedContent;
    stopWatcher();
    watchedPath = target;
    lastWatchedContent = savedContent;
    startWatch();
  };

  startWatch();
}

function loadLibraryForRenderer() {
  const loaded = [];
  const validEntries = [];
  for (const entry of store.library) {
    if (!entry || typeof entry !== 'object' || !entry.key) continue;
    try {
      if (entry.type === 'file' && entry.filePath && fs.existsSync(entry.filePath)) {
        const text = readJsonFile(entry.filePath);
        loaded.push({
          key: entry.key,
          type: 'file',
          filePath: path.resolve(entry.filePath),
          fileName: path.basename(entry.filePath),
          text,
        });
        validEntries.push(entry);
      } else if (entry.type === 'inline' && fs.existsSync(inlineFile(entry.key))) {
        const text = readJsonFile(inlineFile(entry.key));
        loaded.push({
          key: entry.key,
          type: 'inline',
          text,
        });
        validEntries.push(entry);
      }
    } catch {
      /* skip unreadable entries */
    }
  }
  if (validEntries.length !== store.library.length) {
    store.library = validEntries;
    saveStore();
  }
  return loaded;
}

function openFileForRenderer(filePath) {
  const resolved = path.resolve(filePath);
  if (!fs.existsSync(resolved)) {
    return { error: `文件不存在：${resolved}` };
  }
  try {
    const text = readJsonFile(resolved);
    pushRecent(resolved);
    attachWatcher(resolved, text);
    return { filePath: resolved, fileName: path.basename(resolved), text };
  } catch (error) {
    return { error: error.message || '读取文件失败' };
  }
}

function resolveTargetPath(target) {
  if (target?.filePath && fs.existsSync(target.filePath)) return path.resolve(target.filePath);
  const key = target?.key || activeTarget.key;
  if (key && fs.existsSync(MANIFEST_PATH)) {
    try {
      const manifest = JSON.parse(readJsonFile(MANIFEST_PATH));
      const entry = (manifest.maps || []).find(item => item.key === key);
      if (entry?.file) {
        const candidate = path.resolve(WORKSPACE_ROOT, entry.file);
        if (fs.existsSync(candidate)) return candidate;
      }
    } catch {
      /* ignore */
    }
  }
  if (activeTarget.filePath && fs.existsSync(activeTarget.filePath)) return path.resolve(activeTarget.filePath);
  return null;
}

function openDocWindow(filePathOrUrl) {
  let targetUrl = filePathOrUrl;
  if (!/^file:/i.test(targetUrl)) {
    targetUrl = `file://${path.resolve(WORKSPACE_ROOT, filePathOrUrl).replace(/\\/g, '/')}`;
  }
  const parsed = new URL(targetUrl);
  if (parsed.protocol !== 'file:') return;
  const localPath = decodeURIComponent(parsed.pathname.replace(/^\/([a-zA-Z]:)/, '$1'));
  const rel = path.relative(WORKSPACE_ROOT, path.resolve(localPath));
  if (rel.startsWith('..') || path.isAbsolute(rel)) return;

  if (docWindow && !docWindow.isDestroyed()) {
    docWindow.loadURL(targetUrl);
    docWindow.focus();
    return;
  }
  const iconPath = path.join(__dirname, 'app.ico');
  docWindow = new BrowserWindow({
    width: 1080,
    height: 820,
    parent: mainWindow || undefined,
    title: '工作台文档',
    ...(fs.existsSync(iconPath) ? { icon: iconPath } : {}),
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  docWindow.setMenuBarVisibility(false);
  docWindow.loadURL(targetUrl);
  docWindow.on('closed', () => { docWindow = null; });
}

function sendCommand(command, arg) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('desktop:command', command, arg);
  }
}

function setWatchEnabled(enabled) {
  store.watchEnabled = Boolean(enabled);
  saveStore();
  if (watchedPath) {
    if (store.watchEnabled) attachWatcher(watchedPath);
    else {
      const keep = watchedPath;
      const keepText = lastWatchedContent;
      stopWatcher();
      watchedPath = keep;
      lastWatchedContent = keepText;
    }
  }
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('desktop:watch-changed', store.watchEnabled);
  }
}

function createMainWindow() {
  const bounds = clampBounds(store.bounds);
  const iconPath = path.join(__dirname, 'app.ico');
  mainWindow = new BrowserWindow({
    ...bounds,
    minWidth: 960,
    minHeight: 640,
    title: '关卡工作台',
    ...(fs.existsSync(iconPath) ? { icon: iconPath } : {}),
    backgroundColor: '#fffdf6',
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  mainWindow.setMenuBarVisibility(false);

  if (store.maximized) mainWindow.maximize();
  mainWindow.once('ready-to-show', () => {
    mainWindow?.show();
  });

  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return;
    const mod = input.control || input.meta;
    if (mod && !input.shift && !input.alt && input.key.toLowerCase() === 'o') {
      event.preventDefault();
      sendCommand('open');
    } else if (mod && !input.shift && !input.alt && input.key.toLowerCase() === 'e') {
      event.preventDefault();
      sendCommand('export-svg');
    } else if (mod && input.shift && !input.alt && input.key.toLowerCase() === 's') {
      event.preventDefault();
      sendCommand('export-notes');
    } else if (mod && input.shift && !input.alt && input.key.toLowerCase() === 'r') {
      event.preventDefault();
      const p = resolveTargetPath();
      if (p) shell.showItemInFolder(p);
    } else if (mod && !input.shift && !input.alt && input.key.toLowerCase() === 'r') {
      event.preventDefault();
      mainWindow.webContents.reload();
    } else if (input.key === 'F11') {
      event.preventDefault();
      mainWindow.setFullScreen(!mainWindow.isFullScreen());
    } else if (input.key === 'F12') {
      event.preventDefault();
      mainWindow.webContents.toggleDevTools();
    }
  });

  if (store.maximized) mainWindow.maximize();
  mainWindow.once('ready-to-show', () => {
    mainWindow?.show();
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    openDocWindow(url);
    return { action: 'deny' };
  });

  mainWindow.webContents.on('will-navigate', (event, url) => {
    const target = url.split('#')[0];
    const expected = `file://${INDEX_HTML.replace(/\\/g, '/')}`;
    if (target.toLowerCase() !== expected.toLowerCase()) {
      event.preventDefault();
      openDocWindow(url);
    }
  });

  const persistWindowBounds = () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    store.maximized = mainWindow.isMaximized();
    if (!store.maximized) {
      store.bounds = mainWindow.getBounds();
    }
    saveStore();
  };
  mainWindow.on('resize', persistWindowBounds);
  mainWindow.on('move', persistWindowBounds);
  mainWindow.on('close', persistWindowBounds);
  mainWindow.on('closed', () => {
    stopWatcher();
    mainWindow = null;
  });

  mainWindow.loadFile(INDEX_HTML);
}

function registerIpc() {
  ipcMain.handle('desktop:init-state', () => {
    const initialFile = pendingLaunchFile;
    pendingLaunchFile = null;
    const defaults = readDesktopDefaults();
    return {
      watchEnabled: store.watchEnabled,
      preloadBuiltinSamples: Boolean(defaults.preloadBuiltinSamples && !store.samplesSeeded && store.library.length === 0),
      recentFiles: recentItems(),
      libraryItems: loadLibraryForRenderer(),
      activeKey: store.activeLibraryKey,
      initialFile: initialFile ? openFileForRenderer(initialFile) : null,
    };
  });

  ipcMain.handle('desktop:save-library-item', (_event, item) => {
    if (!item || !item.key) return false;
    const entry = {
      key: String(item.key),
      type: item.type === 'file' ? 'file' : 'inline',
      filePath: item.filePath ? path.resolve(item.filePath) : undefined,
    };
    if (entry.type === 'inline' && typeof item.text === 'string') {
      fs.mkdirSync(inlineDir(), { recursive: true });
      fs.writeFileSync(inlineFile(entry.key), item.text, 'utf8');
    }
    store.samplesSeeded = true;
    store.library = [entry, ...store.library.filter(it => it.key !== entry.key && (!entry.filePath || it.filePath !== entry.filePath))];
    store.activeLibraryKey = entry.key;
    saveStore();
    return true;
  });

  ipcMain.handle('desktop:remove-library-item', (_event, key) => {
    const target = String(key || '');
    const removed = store.library.find(it => it.key === target);
    store.library = store.library.filter(it => it.key !== target);
    if (removed?.type === 'inline' && fs.existsSync(inlineFile(target))) {
      try { fs.unlinkSync(inlineFile(target)); } catch { /* ignore */ }
    }
    if (store.activeLibraryKey === target) {
      store.activeLibraryKey = store.library[0]?.key || null;
    }
    saveStore();
    return true;
  });

  ipcMain.handle('desktop:clear-library', () => {
    stopWatcher();
    store.samplesSeeded = true;
    store.library = [];
    store.activeLibraryKey = null;
    saveStore();
    try { fs.rmSync(inlineDir(), { recursive: true, force: true }); } catch { /* ignore */ }
    return true;
  });

  ipcMain.handle('desktop:set-active-key', (_event, key) => {
    store.activeLibraryKey = key ? String(key) : null;
    saveStore();
    return true;
  });

  ipcMain.handle('desktop:open-file-dialog', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: '打开关卡地图 JSON',
      defaultPath: store.lastOpenDir,
      properties: ['openFile'],
      filters: [
        { name: '关卡地图 JSON', extensions: ['json'] },
        { name: '所有文件', extensions: ['*'] },
      ],
    });
    if (result.canceled || !result.filePaths.length) return { canceled: true };
    return openFileForRenderer(result.filePaths[0]);
  });

  ipcMain.handle('desktop:open-file-path', (_event, filePath) => {
    if (!filePath || typeof filePath !== 'string') return { error: '无效路径' };
    return openFileForRenderer(filePath);
  });

  ipcMain.handle('desktop:get-recent', () => recentItems());

  ipcMain.handle('desktop:clear-recent', () => {
    store.recentFiles = [];
    saveStore();
    return [];
  });

  ipcMain.handle('desktop:reload-watched', () => {
    if (!watchedPath) return { error: '当前没有关联磁盘文件' };
    return openFileForRenderer(watchedPath);
  });

  ipcMain.handle('desktop:set-watch', (_event, enabled) => {
    setWatchEnabled(enabled);
    return store.watchEnabled;
  });

  ipcMain.handle('desktop:stop-watch', () => {
    stopWatcher();
    return true;
  });

  ipcMain.handle('desktop:save-file', async (_event, payload) => {
    const defaultName = String(payload?.defaultName || 'map.json');
    const result = await dialog.showSaveDialog(mainWindow, {
      title: String(payload?.title || '保存文件'),
      defaultPath: path.join(store.lastSaveDir || WORKSPACE_ROOT, defaultName),
      filters: Array.isArray(payload?.filters) ? payload.filters : [{ name: '所有文件', extensions: ['*'] }],
    });
    if (result.canceled || !result.filePath) return { canceled: true };
    fs.writeFileSync(result.filePath, String(payload?.content ?? ''), 'utf8');
    store.lastSaveDir = path.dirname(result.filePath);
    saveStore();
    return { saved: true, filePath: result.filePath };
  });

  ipcMain.handle('desktop:copy-text', (_event, text) => {
    clipboard.writeText(String(text ?? ''));
    return true;
  });

  ipcMain.handle('desktop:reveal-file', (_event, target) => {
    const p = resolveTargetPath(target);
    if (!p) return false;
    shell.showItemInFolder(p);
    return true;
  });

  ipcMain.handle('desktop:open-editor', async (_event, target) => {
    const p = resolveTargetPath(target);
    if (!p) return { ok: false, error: '找不到对应源文件' };
    const err = await shell.openPath(p);
    return { ok: !err, error: err || '' };
  });

  ipcMain.handle('desktop:rebuild-builtins', () => new Promise(resolve => {
    execFile('python', [path.join(WORKSPACE_ROOT, 'tools', 'build.py')], { cwd: WORKSPACE_ROOT }, (error, stdout, stderr) => {
      if (error) {
        resolve({ ok: false, error: stderr || error.message });
      } else {
        resolve({ ok: true, output: stdout });
      }
    });
  }));


  ipcMain.on('desktop:active-map', (_event, info) => {
    activeTarget = {
      key: info?.key || null,
      filePath: info?.filePath || null,
      title: info?.title || '关卡工作台',
    };
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (!activeTarget.key && activeTarget.title === '关卡工作台') {
        mainWindow.setTitle('关卡工作台');
      } else {
        const suffix = activeTarget.filePath ? ` · ${path.basename(activeTarget.filePath)}` : '';
        mainWindow.setTitle(`${activeTarget.title}${suffix} — 关卡工作台`);
      }
    }
  });
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', (_event, argv) => {
    const file = findJsonArg(argv.slice(1));
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
      if (file) {
        const payload = openFileForRenderer(file);
        mainWindow.webContents.send('desktop:open-file', payload);
      }
    }
  });

  app.whenReady().then(() => {
    loadStore();
    registerIpc();
    Menu.setApplicationMenu(null);
    createMainWindow();
  });

  app.on('window-all-closed', () => {
    app.quit();
  });
}
