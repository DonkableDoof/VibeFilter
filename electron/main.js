const { app, BrowserWindow, ipcMain, dialog, nativeImage, protocol, Menu } = require("electron");
const path = require("path");
const fs = require("fs");
const os = require("os");

// Allow our custom protocol to be treated like https (needed for media).
protocol.registerSchemesAsPrivileged([
  { scheme: "vfile", privileges: { secure: true, stream: true, bypassCSP: true, supportFetchAPI: true } },
]);

// Where we persist the library (metadata + tags). Audio stays on disk at its
// real path — we only store the path, so files survive restarts.
const DATA_DIR = path.join(app.getPath("userData"));
const LIBRARY_FILE = path.join(DATA_DIR, "library.json");
const COVER_CACHE = path.join(DATA_DIR, "covers");
const COVER_BANK = path.join(DATA_DIR, "cover-bank");

if (!fs.existsSync(COVER_CACHE)) fs.mkdirSync(COVER_CACHE, { recursive: true });
if (!fs.existsSync(COVER_BANK)) fs.mkdirSync(COVER_BANK, { recursive: true });

let win;

function createWindow() {
  // Hide the File/Edit/View… application menu entirely.
  Menu.setApplicationMenu(null);

  win = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: "#0c0f17",
    icon: path.join(__dirname, "app-icon.png"),
    autoHideMenuBar: true,
    titleBarStyle: "hiddenInset",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  const startUrl = process.env.ELECTRON_START_URL;
  if (startUrl) {
    win.loadURL(startUrl);
    win.webContents.openDevTools({ mode: "detach" });
  } else {
    win.loadFile(path.join(__dirname, "..", "dist", "index.html"));
  }
}

app.whenReady().then(() => {
  // vfile://<url-encoded-absolute-path> → streams the local file with range support
  protocol.handle("vfile", (request) => {
    const url = request.url.replace(/^vfile:\/\//, "");
    const filePath = decodeURIComponent(url);
    try {
      if (!fs.existsSync(filePath)) return new Response(null, { status: 404 });
      const stat = fs.statSync(filePath);
      const total = stat.size;
      const ext = path.extname(filePath).toLowerCase();
      const mimeMap = {
        ".mp3": "audio/mpeg", ".wav": "audio/wav", ".m4a": "audio/mp4",
        ".aac": "audio/aac", ".ogg": "audio/ogg", ".flac": "audio/flac",
        ".aif": "audio/aiff", ".aiff": "audio/aiff",
        ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png",
      };
      const mime = mimeMap[ext] || "application/octet-stream";

      const range = request.headers.get("range");
      if (range) {
        const m = /bytes=(\d*)-(\d*)/.exec(range);
        let start = m && m[1] ? parseInt(m[1], 10) : 0;
        let end = m && m[2] ? parseInt(m[2], 10) : total - 1;
        if (isNaN(start)) start = 0;
        if (isNaN(end) || end >= total) end = total - 1;
        if (start > end) start = 0;
        const chunk = fs.readFileSync(filePath).subarray(start, end + 1);
        return new Response(chunk, {
          status: 206,
          headers: {
            "Content-Type": mime,
            "Content-Range": `bytes ${start}-${end}/${total}`,
            "Accept-Ranges": "bytes",
            "Content-Length": String(end - start + 1),
          },
        });
      }

      const data = fs.readFileSync(filePath);
      return new Response(data, {
        status: 200,
        headers: {
          "Content-Type": mime,
          "Accept-Ranges": "bytes",
          "Content-Length": String(total),
        },
      });
    } catch (e) {
      return new Response(null, { status: 500 });
    }
  });
  createWindow();
});
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

// ─── Library persistence ───
ipcMain.handle("library:load", () => {
  try {
    if (fs.existsSync(LIBRARY_FILE)) {
      return JSON.parse(fs.readFileSync(LIBRARY_FILE, "utf-8"));
    }
  } catch (e) {
    console.error("library load failed", e);
  }
  return { tracks: [], tags: null, settings: null };
});

ipcMain.handle("library:save", (_e, data) => {
  try {
    fs.writeFileSync(LIBRARY_FILE, JSON.stringify(data, null, 2));
    return true;
  } catch (e) {
    console.error("library save failed", e);
    return false;
  }
});

// ─── Add files: open dialog, return parsed track objects ───
ipcMain.handle("files:pick", async () => {
  const res = await dialog.showOpenDialog(win, {
    properties: ["openFile", "multiSelections"],
    filters: [
      { name: "Audio", extensions: ["mp3", "wav", "m4a", "aac", "ogg", "flac", "aif", "aiff"] },
    ],
  });
  if (res.canceled) return [];
  return processFiles(res.filePaths);
});

// ─── Process dropped file paths (from drag-in) ───
ipcMain.handle("files:process", async (_e, filePaths) => {
  return processFiles(filePaths);
});

async function processFiles(filePaths) {
  const mm = await import("music-metadata");
  const out = [];
  for (const filePath of filePaths) {
    try {
      const stat = fs.statSync(filePath);
      if (!stat.isFile()) continue;
      const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      let coverPath = null;
      let durationSec = 0;
      let metaArtist = null;
      let metaTitle = null;
      try {
        const meta = await mm.parseFile(filePath, { duration: true });
        durationSec = meta.format.duration || 0;
        metaArtist = meta.common.artist || null;
        metaTitle = meta.common.title || null;
        const pic = meta.common.picture && meta.common.picture[0];
        if (pic) {
          const ext = pic.format.includes("png") ? "png" : "jpg";
          coverPath = path.join(COVER_CACHE, `${id}.${ext}`);
          fs.writeFileSync(coverPath, pic.data);
        }
      } catch (e) {
        // metadata parse can fail on odd files; keep the track anyway
      }
      out.push({
        id,
        filePath,
        fileName: path.basename(filePath),
        name: path.basename(filePath).replace(/\.[^.]+$/, ""),
        metaArtist,
        metaTitle,
        durationSec,
        coverPath,
        size: stat.size,
        tags: [],
        addedAt: Date.now(),
      });
    } catch (e) {
      console.error("process failed for", filePath, e);
    }
  }
  return out;
}

// ─── Cover bank: list / add / delete ───
ipcMain.handle("bank:list", () => {
  try {
    return fs.readdirSync(COVER_BANK)
      .filter((f) => /\.(jpg|jpeg|png|webp|gif)$/i.test(f))
      .map((f) => ({ id: f, path: path.join(COVER_BANK, f) }));
  } catch {
    return [];
  }
});

ipcMain.handle("bank:add", async () => {
  const res = await dialog.showOpenDialog(win, {
    properties: ["openFile", "multiSelections"],
    filters: [{ name: "Images", extensions: ["jpg", "jpeg", "png", "webp", "gif"] }],
  });
  if (res.canceled) return [];
  const added = [];
  for (const src of res.filePaths) {
    try {
      const ext = path.extname(src).toLowerCase();
      const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}${ext}`;
      const dest = path.join(COVER_BANK, id);
      fs.copyFileSync(src, dest);
      added.push({ id, path: dest });
    } catch (e) {
      console.error("bank add failed", e);
    }
  }
  return added;
});

ipcMain.handle("bank:delete", (_e, id) => {
  try {
    const p = path.join(COVER_BANK, path.basename(id));
    if (fs.existsSync(p)) fs.unlinkSync(p);
    return true;
  } catch {
    return false;
  }
});

// ─── Drag a track OUT into Premiere (or any app/Finder) ───
ipcMain.on("drag:start", (event, filePath, iconDataUrl) => {
  if (!filePath || !fs.existsSync(filePath)) return;
  // Prefer the card image rendered by the UI so the drag shows the track,
  // not a generic file icon.
  let icon = null;
  if (typeof iconDataUrl === "string" && iconDataUrl.startsWith("data:image/")) {
    try {
      const img = nativeImage.createFromDataURL(iconDataUrl);
      if (!img.isEmpty()) icon = img;
    } catch (e) { /* fall through to the default icon */ }
  }
  if (!icon) {
    const named = nativeImage.createFromNamedImage
      ? nativeImage.createFromNamedImage("NSAudio", [0, 0, 1])
      : nativeImage.createEmpty();
    icon = named.isEmpty() ? path.join(__dirname, "drag-icon.png") : named;
  }
  event.sender.startDrag({ file: filePath, icon });
});

// ─── Reveal a file in Finder/Explorer (fallback / convenience) ───
const { shell } = require("electron");
ipcMain.on("file:reveal", (_e, filePath) => {
  if (filePath && fs.existsSync(filePath)) shell.showItemInFolder(filePath);
});

// ─── Open a URL in the user's default browser ───
ipcMain.on("url:open", (_e, url) => {
  if (typeof url === "string" && /^https?:\/\//.test(url)) shell.openExternal(url);
});

// ─── Change the window icon to match the chosen accent theme ───
// Maps the accent names from the UI (theme.js ACCENTS) to icon files.
const ACCENT_ICON_FILES = {
  "Blue / Pink": "app-icon-blue-pink.png",
  "Green / Lime": "app-icon-green-lime.png",
  "Purple / Pink": "app-icon-purple-pink.png",
  "Orange / Red": "app-icon-orange-red.png",
  "Teal / Cyan": "app-icon-teal-cyan.png",
};
ipcMain.on("icon:set", (_e, accentName) => {
  if (!win) return;
  const file = ACCENT_ICON_FILES[accentName];
  if (!file) return;
  const iconPath = path.join(__dirname, "icons", file);
  if (fs.existsSync(iconPath)) win.setIcon(iconPath);
});

// ─── Serve a file's bytes as a data URL for playback + cover display ───
ipcMain.handle("file:read", (_e, filePath) => {
  try {
    if (!fs.existsSync(filePath)) return null;
    return filePath; // renderer uses file:// via custom protocol below
  } catch {
    return null;
  }
});
