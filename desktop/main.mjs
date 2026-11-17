// Blueprint as a desktop app. This is Electron's main process: it starts the
// Blueprint server for the board you worked on last, opens it in a window, and
// adds the menu bar. The board page itself is the same page the browser shows.
//
//   npm run app

import { app, BrowserWindow, Menu, shell, session, nativeTheme, dialog } from 'electron';
import path from 'node:path';
import { mkdir } from 'node:fs/promises';
import { startServer, defaultBoardsDir } from '../server.mjs';
import { defaultHome, listProjects } from '../lib/recents.mjs';
import { startCaptureService } from './capture.mjs';

app.setName('Blueprint');

// Each board's server runs on a port from 4400 to 4409. The window may show
// those and nothing else; any other address opens in the default browser.
const BOARD_ORIGIN = /^http:\/\/127\.0\.0\.1:440\d$/;
const isBoard = (url) => {
  try {
    return BOARD_ORIGIN.test(new URL(url).origin);
  } catch {
    return false;
  }
};
const openOutside = (url) => {
  if (/^https?:\/\//i.test(url)) shell.openExternal(url);
};

let win = null;
let owned = null; // the server this app started itself, closed on quit
let capture = null;

// Open the board edited last, as the browser version does. If no board exists
// yet, make one in ~/Blueprint. If a board's server is already running (an
// outside agent started it), show that one instead of starting another.
async function firstBoardUrl() {
  const recent = (await listProjects(defaultHome())).find((p) => !p.missing);
  if (recent?.url) return recent.url;
  const root = recent?.root || path.join(defaultBoardsDir(), 'My first board');
  await mkdir(root, { recursive: true });
  try {
    owned = await startServer({ root });
    return owned.url;
  } catch (err) {
    if (err.code === 'ALREADY_RUNNING') return `http://127.0.0.1:${err.port}`;
    throw err;
  }
}

function createWindow(url) {
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    title: 'Blueprint',
    // The page's own background, so the window does not flash white while it loads.
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#111112' : '#f2f2f4',
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
  });
  win.webContents.setWindowOpenHandler(({ url: target }) => {
    openOutside(target);
    return { action: 'deny' };
  });
  // A file dropped outside the board, or a link, would otherwise replace the board.
  win.webContents.on('will-navigate', (e, target) => {
    if (isBoard(target)) return;
    e.preventDefault();
    openOutside(target);
  });
  win.on('closed', () => (win = null));
  win.loadURL(`${url}/`);
}

// Tell the page to show the Boards list, or its New board form. recents.js
// listens for these hashes. The page may be on any board's port, so this uses
// the address it is showing now.
function showBoards(hash) {
  if (!win) return;
  const { origin } = new URL(win.webContents.getURL());
  win.webContents.executeJavaScript(`location.hash = ${JSON.stringify(hash)}`).catch(() => win.loadURL(`${origin}/`));
}

function buildMenu() {
  const template = [
    { role: 'appMenu' },
    {
      label: 'File',
      submenu: [
        { label: 'New Board…', accelerator: 'CmdOrCtrl+N', click: () => showBoards('#new') },
        { label: 'Boards', accelerator: 'CmdOrCtrl+Shift+B', click: () => showBoards('#boards') },
        { type: 'separator' },
        { role: 'close' },
      ],
    },
    // Copy, paste and select-all only work in an Electron window on macOS
    // when the Edit menu offers them.
    { role: 'editMenu' },
    // No zoom items: Cmd+plus and pinch zoom the board, not the window.
    { label: 'View', submenu: [{ role: 'reload' }, { role: 'toggleDevTools' }, { type: 'separator' }, { role: 'togglefullscreen' }] },
    { role: 'windowMenu' },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// Only one copy of the app: opening it again brings the window forward.
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => {
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.focus();
  });

  app.whenReady().then(async () => {
    // The page never needs the camera, microphone, location or notifications.
    // Clipboard access stays on for copy and paste.
    session.defaultSession.setPermissionRequestHandler((_wc, permission, done) => done(permission.startsWith('clipboard')));

    capture = await startCaptureService();
    // Every server started from here on inherits this, including other boards'.
    process.env.BLUEPRINT_CAPTURE = capture.url;

    buildMenu();
    try {
      createWindow(await firstBoardUrl());
    } catch (err) {
      dialog.showErrorBox('Blueprint could not start', err.message);
      app.quit();
    }

    // macOS keeps the app running with no window. Clicking the Dock icon opens one again.
    app.on('activate', async () => {
      if (!win) createWindow(await firstBoardUrl());
    });
  });

  // Without this, closing the last window quits the app, which is not how macOS apps behave.
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });

  // Close the server this app owns before quitting, so the board is saved.
  let quitting = false;
  app.on('will-quit', (e) => {
    if (quitting) return;
    quitting = true;
    e.preventDefault();
    Promise.allSettled([owned?.close(), capture?.close()]).finally(() => app.exit(0));
  });
}
