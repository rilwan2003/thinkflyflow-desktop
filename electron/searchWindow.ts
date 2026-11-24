/**
 * Global search window (M4).
 *
 * A frameless, always-on-top window summoned by a global hotkey. It is the
 * "find the thing I know I have" entry point (P1): one keystroke from anywhere,
 * type a phrase, get the file back.
 *
 * Design choices that matter:
 *  - It hides rather than closes, so the next summon is instant.
 *  - It is created lazily on first summon: no cost at startup, no window
 *    flashing into existence during sign-in.
 *  - It is never the tracked main window, so closing it cannot quit the app
 *    while sync is running.
 */
import { app, BrowserWindow, screen } from 'electron';
import * as path from 'node:path';

let searchWindow: BrowserWindow | null = null;

export function isSearchWindowOpen(): boolean {
  return searchWindow !== null && !searchWindow.isDestroyed();
}

/** Open AND on screen. `isSearchWindowOpen` is true for a hidden palette too. */
export function isSearchWindowVisible(): boolean {
  return isSearchWindowOpen() && searchWindow!.isVisible();
}

export function toggleSearchWindow(): void {
  if (isSearchWindowOpen() && searchWindow!.isVisible()) {
    hideSearchWindow();
    return;
  }
  showSearchWindow();
}

export function showSearchWindow(): void {
  if (!isSearchWindowOpen()) searchWindow = createSearchWindow();
  const win = searchWindow!;
  positionNearTopCentre(win);
  win.show();
  win.focus();
  // Reset the input and focus it.
  win.webContents.send('tff:search-window-shown');
}

export function hideSearchWindow(): void {
  if (isSearchWindowOpen()) searchWindow!.hide();
}

function positionNearTopCentre(win: BrowserWindow): void {
  // Follow the display the cursor is on, so it appears where the user is
  // looking rather than always on the primary monitor.
  const cursor = screen.getCursorScreenPoint();
  const display = screen.getDisplayNearestPoint(cursor);
  const { x, y, width } = display.workArea;
  const [winWidth] = win.getSize();
  win.setPosition(Math.round(x + (width - winWidth) / 2), Math.round(y + 120));
}

function createSearchWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 680,
    height: 420,
    show: false,
    frame: false,
    resizable: false,
    movable: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    fullscreenable: false,
    backgroundColor: '#f5f1e4',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  // Float above full-screen apps rather than behind them.
  win.setAlwaysOnTop(true, 'floating');

  win.on('blur', () => {
    // Losing focus dismisses the palette, like every other launcher.
    if (!win.isDestroyed()) win.hide();
  });

  win.on('closed', () => {
    searchWindow = null;
  });

  const useDevServer = app.isPackaged === false && process.env.TFF_DEV_SERVER === '1';
  if (useDevServer) {
    void win.loadURL('http://localhost:5173/#search');
  } else {
    void win.loadFile(path.join(__dirname, '..', '..', 'dist', 'index.html'), { hash: 'search' });
  }

  return win;
}
