const { app, BrowserWindow, session, desktopCapturer, ipcMain, Menu, nativeTheme } = require('electron');
const { spawn, execFile } = require('node:child_process');
const { promisify } = require('node:util');
const path = require('node:path');
const { createUpdateController } = require('./update-controller.cjs');
const { prepareMigration } = require('./session-migration.cjs');
// Local development is explicit and is unavailable in packaged releases.
const ORIGIN = !app.isPackaged && process.env.KRUG_DESKTOP_DEV === '1' ? 'http://127.0.0.1:5173' : 'https://chat.nioservices.website';
const helper = app.isPackaged ? path.join(process.resourcesPath, 'capture', 'Krug.Capture.exe') : path.join(__dirname, 'capture', 'publish', 'Krug.Capture.exe');
let mainWindow, picker, permissionWindow, selectedPid, capture;
let updateStatus = { state: 'idle' }, updateController;
function reportUpdate(status) { updateStatus = status; if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('krug:update-status', status); }
function fromMain(event) {
  try { return event.sender === mainWindow?.webContents && event.senderFrame === mainWindow.webContents.mainFrame && new URL(event.senderFrame.url).origin === ORIGIN; } catch { return false; }
}
function stopAudio() {
  const old = capture; capture = undefined;
  if (old) { old.stdin.end('\n'); setTimeout(() => { if (old.exitCode === null) old.kill(); }, 1000).unref(); }
}
async function chooseSource(sources) {
  if (picker) return null;
  picker = new BrowserWindow({ parent: mainWindow, modal: true, width: 740, height: 640, show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, preload: path.join(__dirname, 'picker-preload.cjs') } });
  const current = picker;
  return new Promise(resolve => {
    let done = false;
    const finish = value => { if (done) return; done = true; ipcMain.removeListener('krug:picker-choice', onChoice); picker = undefined; if (!current.isDestroyed()) current.close(); resolve(value); };
    const onChoice = (event, choice) => {
      if (event.sender !== current.webContents || event.senderFrame !== current.webContents.mainFrame) return;
      const source = sources.find(s => s.id === choice?.id);
      finish(source ? { source, audio: choice.audio === true && source.id.startsWith('window:') } : null);
    };
    ipcMain.on('krug:picker-choice', onChoice);
    current.once('closed', () => finish(null));
    current.webContents.once('did-finish-load', () => { current.webContents.send('krug:picker-sources', sources.map(s => ({ id: s.id, name: s.name, image: s.thumbnail.toDataURL() }))); current.show(); });
    current.loadFile(path.join(__dirname, 'picker.html')).catch(() => finish(null));
  });
}
async function askMediaPermission(devices) {
  if (permissionWindow) return false;
  permissionWindow = new BrowserWindow({ parent: mainWindow, modal: true, width: 480, height: 300, resizable: false, show: false,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, preload: path.join(__dirname, 'permission-preload.cjs') } });
  const current = permissionWindow;
  return new Promise(resolve => {
    let done = false;
    const finish = value => { if (done) return; done = true; ipcMain.removeListener('krug:permission-choice', onChoice); permissionWindow = undefined; if (!current.isDestroyed()) current.close(); resolve(value); };
    const onChoice = (event, allow) => { if (event.sender === current.webContents && event.senderFrame === current.webContents.mainFrame) finish(allow === true); };
    ipcMain.on('krug:permission-choice', onChoice);
    current.once('closed', () => finish(false));
    current.webContents.once('did-finish-load', () => { current.webContents.send('krug:permission-devices', devices); current.show(); });
    current.loadFile(path.join(__dirname, 'permission.html')).catch(() => finish(false));
  });
}
async function createWindow() {
  const ses = session.fromPartition('persist:krug');
  ses.setPermissionCheckHandler((contents, permission, origin) => contents === mainWindow?.webContents && origin === ORIGIN && ['speaker-selection', 'display-capture', 'fullscreen'].includes(permission));
  ses.setPermissionRequestHandler((contents, permission, callback, details) => {
    let origin = ''; try { origin = new URL(details.requestingUrl).origin; } catch {}
    if (contents !== mainWindow?.webContents || origin !== ORIGIN) return callback(false);
    // Display capture still requires the explicit source picker below.
    if (['speaker-selection', 'display-capture', 'fullscreen'].includes(permission)) return callback(true);
    if (permission !== 'media') return callback(false);
    const types = details.mediaTypes || [];
    const devices = [types.includes('audio') ? 'микрофону' : '', types.includes('video') ? 'камере' : ''].filter(Boolean).join(' и ') || 'микрофону или камере';
    askMediaPermission(devices).then(callback).catch(() => callback(false));
  });
  ses.setDisplayMediaRequestHandler(async (request, callback) => {
    selectedPid = undefined;
    try {
      if (!request.userGesture || request.frame !== mainWindow?.webContents.mainFrame || new URL(request.frame.url).origin !== ORIGIN) return callback(null);
      const sources = await desktopCapturer.getSources({ types: ['window', 'screen'], thumbnailSize: { width: 220, height: 124 } });
      const ownHandle = mainWindow.getNativeWindowHandle().readBigUInt64LE().toString();
      const choice = await chooseSource(sources.filter(s => s.id !== `window:${ownHandle}:0`));
      if (!choice) return callback(null);
      if (choice.audio) {
        const match = /^window:(\d+):\d+$/.exec(choice.source.id);
        if (!match) throw new Error('Invalid window identifier');
        const result = await promisify(execFile)(helper, ['--window', match[1]], { timeout: 5000, windowsHide: true });
        const matchProcess = /^(\d+) (\d+)$/.exec(result.stdout.trim());
        const pid = Number(matchProcess?.[1]);
        if (!matchProcess || !Number.isSafeInteger(pid) || pid <= 0 || app.getAppMetrics().some(p => p.pid === pid)) throw new Error('Invalid process');
        selectedPid = [matchProcess[1], matchProcess[2]];
      }
      callback({ video: choice.source });
    } catch { callback(null); }
  });
  mainWindow = new BrowserWindow({ width: 1280, height: 820, minWidth: 600, minHeight: 500, title: 'Круг', backgroundColor: '#14121c', show: app.isPackaged || process.env.KRUG_DESKTOP_TEST !== '1', webPreferences: { session: ses, sandbox: true, contextIsolation: true, nodeIntegration: false, preload: path.join(__dirname, 'preload.cjs') } });
  configureUpdates();
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-navigate', (event, url) => { try { if (new URL(url).origin !== ORIGIN) event.preventDefault(); } catch { event.preventDefault(); } });
  mainWindow.webContents.on('did-start-navigation', (_e, _url, inPlace, isMainFrame) => { if (isMainFrame && !inPlace) { stopAudio(); selectedPid = undefined; updateController?.resetCallState(); } });
  mainWindow.on('closed', () => { stopAudio(); selectedPid = undefined; });
  await mainWindow.loadURL(ORIGIN);
}
ipcMain.handle('krug:audio-start', async event => {
  if (!fromMain(event)) throw new Error('Invalid sender');
  if (!selectedPid) return false;
  if (capture) throw new Error('Capture already active');
  const target = selectedPid; selectedPid = undefined;
  const child = spawn(helper, target, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }); capture = child;
  child.stdin.on('error', () => {});
  let started = false;
  child.once('exit', () => { if (capture === child) { capture = undefined; if (started && !mainWindow.isDestroyed()) mainWindow.webContents.send('krug:audio-ended'); } });
  let diagnostic = '';
  const ready = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Capture startup timed out')), 8000);
    child.stderr.on('data', chunk => { diagnostic = (diagnostic + chunk.toString()).slice(-4096); if (diagnostic.includes('READY 44100 2 f32le')) { clearTimeout(timer); resolve(true); } });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', () => { clearTimeout(timer); reject(new Error('Capture stopped')); });
  }).catch(error => { stopAudio(); throw error; });
  if (capture !== child || child.exitCode !== null) throw new Error('Capture stopped');
  started = true;
  child.stdout.on('data', bytes => { if (capture === child && !mainWindow.isDestroyed()) mainWindow.webContents.send('krug:audio-data', bytes); });
  return ready;
});
ipcMain.handle('krug:audio-stop', event => { if (!fromMain(event)) throw new Error('Invalid sender'); selectedPid = undefined; stopAudio(); });
ipcMain.handle('krug:call-state', (event, active) => { if (!fromMain(event) || typeof active !== 'boolean') throw new Error('Invalid sender or call state'); updateController?.setCallActive(active); });
ipcMain.handle('krug:update-state', event => { if (!fromMain(event)) throw new Error('Invalid sender'); return updateStatus; });
function configureUpdates() {
  if (!app.isPackaged) return;
  const { autoUpdater } = require('./generated/updater.cjs');
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = false;
  autoUpdater.disableDifferentialDownload = true;
  let checking = false, downloading = false, pending = false, migrateToWebView = false;
  updateController = createUpdateController({
    install: () => autoUpdater.quitAndInstall(true, true), report: reportUpdate,
    prepare: async () => {
      if (!migrateToWebView) return;
      await prepareMigration({ origin: ORIGIN, sessionFetch: (...args) => mainWindow.webContents.session.fetch(...args),
        helper: path.join(process.resourcesPath, 'session-helper', 'Krug.SessionHelper.exe'),
        directory: path.join(app.getPath('appData'), 'KrugMigration') });
    },
    onPrepareError: () => { pending = false; },
  });
  autoUpdater.on('update-available', () => { downloading = true; reportUpdate({ state: 'downloading', percent: 0 }); });
  autoUpdater.on('update-not-available', () => reportUpdate({ state: 'idle' }));
  autoUpdater.on('download-progress', info => reportUpdate({ state: 'downloading', percent: Math.max(0, Math.min(100, Math.round(info.percent))) }));
  autoUpdater.on('update-downloaded', info => { downloading = false; pending = true; migrateToWebView = info.krugRuntime === 'webview2'; updateController.downloaded(); });
  autoUpdater.on('error', () => { if (downloading || pending) reportUpdate({ state: 'error' }); downloading = false; pending = false; });
  async function check() {
    if (checking || downloading || pending || !mainWindow || mainWindow.isDestroyed()) return;
    checking = true;
    try {
      const response = await mainWindow.webContents.session.fetch(`${ORIGIN}/api/desktop-updates/access`, { credentials: 'include', headers: { 'X-Krug-Desktop-Capability': 'migration-v1' } });
      if (!response.ok) return;
      const data = await response.json();
      if (typeof data.token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(data.token)) return;
      autoUpdater.requestHeaders = { Authorization: `Bearer ${data.token}` };
      await autoUpdater.checkForUpdates();
    } catch { /* Retry later; a missing feed is normal until the first release. */ }
    finally { checking = false; }
  }
  mainWindow.webContents.on('did-finish-load', () => void check());
  mainWindow.on('focus', () => void check());
  setInterval(() => void check(), 10 * 60 * 1000).unref();
}
app.whenReady().then(() => {
  Menu.setApplicationMenu(null);
  nativeTheme.themeSource = 'dark';
  return createWindow();
});
app.on('window-all-closed', () => app.quit());
