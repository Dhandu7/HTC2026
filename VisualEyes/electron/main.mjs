// Electron shell: a transparent, always-on-top, full-screen overlay.
//  - Collapsed: click-through, shows only a small pill in the top-right corner.
//    The camera keeps running so the gaze "hot corner" can reopen it.
//  - Expanded: the keyboard covers the screen. The window is non-focusable, so the
//    app the user was working in keeps keyboard focus and "Insert" can paste into it.
// Toggle: global shortcut (default Ctrl/Cmd+Shift+G), offline voice command, or gaze hot corner.
import { app, BrowserWindow, globalShortcut, ipcMain, screen, session, clipboard, systemPreferences, Tray, nativeImage, Menu } from "electron";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SHORTCUT = process.env.GAZETYPE_SHORTCUT ?? "CommandOrControl+Shift+G";
const DEV_URL = process.env.VITE_DEV_SERVER_URL;

let win = null;
let expanded = true; // open on launch so first-run setup is visible

function setExpanded(v) {
  expanded = v;
  if (!win) return;
  // forward:true keeps mousemove flowing to the page (mouse-mode hot corner/pill hover).
  win.setIgnoreMouseEvents(!v, { forward: true });
  win.webContents.send("visibility", v);
}

function createWindow() {
  const { bounds } = screen.getPrimaryDisplay();
  win = new BrowserWindow({
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
    transparent: true,
    frame: false,
    hasShadow: false,
    resizable: false,
    movable: false,
    skipTaskbar: true,
    focusable: process.env.GAZETYPE_FOCUSABLE === "1",
    alwaysOnTop: true,
    backgroundColor: "#00000000",
    // macOS: a non-activating panel that floats over full-screen apps.
    ...(process.platform === "darwin" ? { type: "panel" } : {}),
    webPreferences: {
      preload: join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      // Keep the camera loop running at full rate while collapsed.
      backgroundThrottling: false,
    },
  });
  win.setAlwaysOnTop(true, "screen-saver");
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  if (DEV_URL) win.loadURL(DEV_URL);
  else win.loadFile(join(__dirname, "../dist/index.html"));
  win.webContents.on("did-finish-load", () => setExpanded(expanded));
}

/** Paste into whatever app has focus. Needs Accessibility permission on macOS. */
function pasteIntoFocusedApp() {
  return new Promise((resolve) => {
    const done = (err) => resolve(!err);
    if (process.platform === "darwin") {
      execFile("osascript", ["-e", 'tell application "System Events" to keystroke "v" using command down'], done);
    } else if (process.platform === "win32") {
      execFile("powershell", ["-NoProfile", "-Command", "Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('^v')"], done);
    } else {
      execFile("xdotool", ["key", "--clearmodifiers", "ctrl+v"], done);
    }
  });
}

app.whenReady().then(async () => {
  // Allow camera + mic for our own page only.
  session.defaultSession.setPermissionRequestHandler((wc, permission, cb) => {
    cb(permission === "media" && wc === win?.webContents);
  });
  if (process.platform === "darwin") {
    await systemPreferences.askForMediaAccess("camera").catch(() => false);
  }

  createWindow();

  const ok = globalShortcut.register(SHORTCUT, () => setExpanded(!expanded));
  console.log(ok ? `[gazetype] shortcut ${SHORTCUT} registered` : `[gazetype] could not register ${SHORTCUT} (another app owns it?) - use the 👁 badge or tray menu`);

  const tray = new Tray(nativeImage.createEmpty());
  tray.setTitle("👁");
  tray.setToolTip("GazeType");
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: `Show / hide (${SHORTCUT})`, click: () => setExpanded(!expanded) },
      { label: "Reload", click: () => win?.reload() },
      { label: "DevTools", click: () => win?.webContents.openDevTools({ mode: "detach" }) },
      { type: "separator" },
      { label: "Quit GazeType", click: () => app.quit() },
    ]),
  );

  ipcMain.on("set-expanded", (_e, v) => setExpanded(!!v));
  // While collapsed the window is click-through; the page asks for clicks only while the pointer is over the badge.
  ipcMain.on("set-clickable", (_e, v) => {
    if (!expanded) win?.setIgnoreMouseEvents(!v, { forward: true });
  });
  ipcMain.handle("get-shortcut", () => SHORTCUT);
  ipcMain.handle("insert-text", async (_e, text) => {
    if (typeof text !== "string" || !text) return false;
    clipboard.writeText(text);
    setExpanded(false);
    await new Promise((r) => setTimeout(r, 120));
    return pasteIntoFocusedApp();
  });
});

app.on("will-quit", () => globalShortcut.unregisterAll());
app.on("window-all-closed", () => app.quit());
