const { app, BrowserWindow, ipcMain, shell, safeStorage } = require('electron');
const { spawn } = require('node:child_process');
const path = require('node:path');

let miningProcess = null;
let miningLogs = [];

function appendMiningLog(line) {
  const text = String(line || '').trim();
  if (!text) return;
  miningLogs.push(`${new Date().toLocaleTimeString()} ${text}`);
  if (miningLogs.length > 200) miningLogs = miningLogs.slice(-200);
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send('mining-log', miningLogs[miningLogs.length - 1]);
  }
}

function miningStatus() {
  return {
    running: Boolean(miningProcess),
    pid: miningProcess?.pid || null,
    logs: miningLogs.slice(-80),
  };
}

function chainDir() {
  if (process.env.FALARI_CHAIN_DIR) return process.env.FALARI_CHAIN_DIR;
  return path.resolve(__dirname, '../../chain');
}

function miningCommand(config) {
  const configured = process.env.FALARI_MINER_BIN || process.env.FALARI_CHAINCTL_BIN;
  if (configured) {
    return {
      command: configured,
      args: ['mine'],
      cwd: chainDir(),
    };
  }
  return {
    command: 'go',
    args: ['run', './cmd/chainctl', 'mine'],
    cwd: chainDir(),
  };
}

ipcMain.handle('mining:status', () => miningStatus());

ipcMain.handle('mining:start', (_event, config = {}) => {
  if (miningProcess) return miningStatus();
  const { command, args, cwd } = miningCommand(config);
  const finalArgs = [
    ...args,
    '-chain', config.chainUrl || 'http://localhost:8080',
    '-addr', config.addr || ':9090',
    '-data', config.dataDir || path.join(app.getPath('userData'), 'miner'),
    '-endpoint', config.endpoint || 'http://localhost:9090',
    '-capacity', String(config.capacity || 1099511627776),
    '-stake', String(config.stake || 1000),
  ];
  if (config.p2pListen) finalArgs.push('-p2p-listen', config.p2pListen);
  if (config.p2pPeers) finalArgs.push('-p2p-peers', config.p2pPeers);
  miningLogs = [];
  appendMiningLog(`starting mining node: ${command} ${finalArgs.join(' ')}`);
  miningProcess = spawn(command, finalArgs, { cwd, env: process.env });
  miningProcess.stdout.on('data', (chunk) => appendMiningLog(chunk));
  miningProcess.stderr.on('data', (chunk) => appendMiningLog(chunk));
  miningProcess.on('exit', (code, signal) => {
    appendMiningLog(`mining node stopped code=${code ?? ''} signal=${signal ?? ''}`);
    miningProcess = null;
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send('mining-status', miningStatus());
    }
  });
  return miningStatus();
});

ipcMain.handle('mining:stop', () => {
  if (miningProcess) {
    miningProcess.kill('SIGTERM');
  }
  return miningStatus();
});

ipcMain.handle('safeStorage:available', () => safeStorage.isEncryptionAvailable());

ipcMain.handle('safeStorage:encrypt', (_event, plaintext) => {
  if (!safeStorage.isEncryptionAvailable()) return null;
  return safeStorage.encryptString(plaintext).toString('base64');
});

ipcMain.handle('safeStorage:decrypt', (_event, base64Encrypted) => {
  if (!safeStorage.isEncryptionAvailable()) return null;
  return safeStorage.decryptString(Buffer.from(base64Encrypted, 'base64'));
});

function createWindow() {
  const win = new BrowserWindow({
    width: 1320,
    height: 860,
    minWidth: 1080,
    minHeight: 720,
    title: 'Falari',
    backgroundColor: '#0b0d10',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    trafficLightPosition: { x: 18, y: 18 },
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  const devUrl = process.env.ELECTRON_START_URL;
  if (devUrl) {
    win.loadURL(devUrl);
  } else {
    win.loadFile(path.join(__dirname, '../dist/index.html'));
  }

  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
}

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (miningProcess) {
    miningProcess.kill('SIGTERM');
    miningProcess = null;
  }
  if (process.platform !== 'darwin') app.quit();
});
