import React, { useState, useRef, useEffect, useMemo, useCallback } from "react";
import { buildTheme, ACCENTS, TAG_PALETTE, DEFAULT_TAGS } from "./theme";
import { Icon, ICONS } from "./icons.jsx";
import { fmtTime, parseName as parseNameBase } from "./helpers";
import { makeStyles } from "./styles";
import { GlobalStyles } from "./GlobalStyles.jsx";
import { TooltipButton } from "./TooltipButton.jsx";
import { Dropdown } from "./Dropdown.jsx";
import { fetchLatestRelease, isNewer, REPO_URL } from "./updateCheck";

/*
  VibeFilter (Electron build)
  ---------------------------
  Native file access — real playback, embedded covers, persistence, and
  drag-into-Premiere — is provided by window.vf (see electron/preload.js).

  This file is the whole UI. It's organized as:
    1. State          — every piece of live data the app tracks
    2. Effects        — load/save, audio events, keyboard shortcuts, waveform
    3. Playback       — select / play / pause / seek / shuffle, volume, waveform
    4. Library        — tags, tracks, rename, filtering & sorting
    5. Cover bank     — upload/assign/remove cover art
    6. Selection      — multi-select for bulk actions
    7. Render         — sidebar, track grid, player panel, dialogs

  The WAVE_BARS / TARGET_RMS tuning constants live just above the functions
  that use them.
*/
const WAVE_BARS = 120;   // number of bars drawn in the waveform
const TARGET_RMS = 0.16; // reference loudness for volume normalization

export default function App() {
  // ── 1. State ──────────────────────────────────────────────────────────────
  // Library & persistence
  const [loaded, setLoaded] = useState(false);
  const [settings, setSettings] = useState({ lightMode: false });
  const [tracks, setTracks] = useState([]);
  const [tags, setTags] = useState(DEFAULT_TAGS);

  // Browsing (filter / search / which track is open)
  const [activeFilters, setActiveFilters] = useState([]);   // tags that must be present
  const [excludedFilters, setExcludedFilters] = useState([]); // tags that must be absent
  const [favsOnly, setFavsOnly] = useState(false);
  const [hideUsed, setHideUsed] = useState(true); // hide tracks already dragged out, until reset
  const [search, setSearch] = useState("");
  const [selectedId, setSelectedId] = useState(null);
  const [dragOver, setDragOver] = useState(false);

  // Tag creation
  const [newTag, setNewTag] = useState("");
  const [newTagColor, setNewTagColor] = useState(TAG_PALETTE[0]);
  const [addTagOpen, setAddTagOpen] = useState(false);

  // Playback
  const audioRef = useRef(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [curTime, setCurTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [volume, setVolume] = useState(1);
  const [peaks, setPeaks] = useState(null); // normalized waveform peaks, or "error", or null while loading
  const peakCache = useRef({});             // trackId -> peaks
  const gainCache = useRef({});             // trackId -> loudness gain multiplier
  const playNextRef = useRef(() => {});     // always holds the latest "play next track" fn
  const waveCanvasRef = useRef(null);
  const introStartRef = useRef(0);   // timestamp when the current wave-in began
  const introRafRef = useRef(null);  // requestAnimationFrame id for the wave-in

  // Cover bank, bulk selection, popups
  const [bank, setBank] = useState([]);                       // [{ id, path }]
  const [bankOpen, setBankOpen] = useState(false);
  const [selectMode, setSelectMode] = useState(false);
  const [selectedTracks, setSelectedTracks] = useState(() => new Set());
  const [bankTargetTrack, setBankTargetTrack] = useState(null); // single-track cover apply target
  const [ctxMenu, setCtxMenu] = useState(null);                 // { x, y, trackId } | null
  const [renaming, setRenaming] = useState(null);              // { trackId, title, artist } | null
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [updateVersion, setUpdateVersion] = useState(null); // newer release tag, or null
  const [updateDismissed, setUpdateDismissed] = useState(false);
  const [creditsCopied, setCreditsCopied] = useState(false);
  const [newItem, setNewItem] = useState(null); // { kind: "playlist"|"profile", name } | null
  const [playlistPicker, setPlaylistPicker] = useState(null); // { trackIds: [] } | null
  const [renameItem, setRenameItem] = useState(null); // { kind, id, name } | null
  const [projectPrompt, setProjectPrompt] = useState(false); // startup project chooser
  const [creditsOpen, setCreditsOpen] = useState(false);     // credits editor
  const [tagsOpen, setTagsOpen] = useState(false);           // manage-tags popup
  const dragCreditIndex = useRef(null);
  const [dragOverCredit, setDragOverCredit] = useState(null);
  const [winW, setWinW] = useState(typeof window !== "undefined" ? window.innerWidth : 1200);
  const [hoverSlice, setHoverSlice] = useState(null); // index of hovered pie slice, or null
  const dragTagIndex = useRef(null);                  // index of tag being dragged
  const [dragOverTag, setDragOverTag] = useState(null); // index currently hovered during tag drag

  const isLight = settings.lightMode;
  const accentName = settings.accent || "Blue / Pink";
  // The ?v= suffix busts the cache whenever the app version changes, so updated
  // icon artwork actually shows instead of a stale cached copy.
  const accentIcon = ({
    "Blue / Pink": "./icon-blue-pink.png",
    "Green / Lime": "./icon-green-lime.png",
    "Purple / Pink": "./icon-purple-pink.png",
    "Orange / Red": "./icon-orange-red.png",
    "Teal / Cyan": "./icon-teal-cyan.png",
  }[accentName] || "./app-icon.png") + `?v=${__APP_VERSION__}`;
  const tileSize = settings.tileSize || "medium";
  const setTileSize = (size) => setSettings((p) => ({ ...p, tileSize: size }));
  const nameLast = !!settings.nameLast;
  // Loop cycles: "list" (wrap the filtered list) → "one" (repeat this track) → "off".
  // Migrates from the older boolean `loop` setting.
  const loopMode = settings.loopMode || (settings.loop === false ? "off" : "list");
  const cycleLoop = () => setSettings((p) => {
    const cur = p.loopMode || (p.loop === false ? "off" : "list");
    const next = cur === "list" ? "one" : cur === "one" ? "off" : "list";
    return { ...p, loopMode: next };
  });

  // ── Playlists ──
  // "All" is a virtual playlist that always shows every track.
  const ALL_PLAYLIST = { id: "all", name: "All tracks" };
  const playlists = settings.playlists || [];
  const activePlaylist = settings.activePlaylist || "all";
  const setActivePlaylist = (id) => setSettings((p) => ({ ...p, activePlaylist: id }));
  const inPlaylist = (tr, plId) =>
    plId === "all" || (Array.isArray(tr.playlists) && tr.playlists.includes(plId));

  // ── Video profiles ──
  // "Used" is tracked per video project, so the same track can be used in one
  // video and still available in another.
  const profiles = settings.profiles && settings.profiles.length
    ? settings.profiles
    : [{ id: "default", name: "Default project" }];
  const activeProfile = settings.activeProfile || profiles[0].id;
  const askProjectOnOpen = settings.askProjectOnOpen !== false; // default on
  const setActiveProfile = (id) => setSettings((p) => ({ ...p, activeProfile: id }));
  const isUsed = (tr) => !!(tr.usedBy && tr.usedBy[activeProfile]);
  const usedAtFor = (tr) => (tr.usedBy && tr.usedBy[activeProfile]) || 0;
  // Set/clear a track's used mark for the active profile.
  const markUsed = (tr, used) => {
    const usedBy = { ...(tr.usedBy || {}) };
    if (used) usedBy[activeProfile] = Date.now();
    else delete usedBy[activeProfile];
    return { ...tr, usedBy };
  };

  // Local wrapper so every parseName call in this file respects the name-format setting.
  const parseName = (tr) => parseNameBase(tr, nameLast);
  const t = useMemo(() => buildTheme(isLight, accentName), [isLight, accentName]);
  const selected = tracks.find((tr) => tr.id === selectedId) || null;

  // ── 2. Effects ────────────────────────────────────────────────────────────
  // Load the saved library and cover bank once on startup.
  useEffect(() => {
    (async () => {
      const lib = await window.vf.loadLibrary();
      if (lib.tracks) {
        setTracks(lib.tracks.map((tr) => {
          let out = tr;
          // Legacy `favorite` key → `favourite`.
          if ("favorite" in out) {
            out = { ...out, favourite: out.favourite ?? out.favorite, favorite: undefined };
          }
          // Legacy single `used` flag → per-profile usedBy map (default project).
          if (!out.usedBy) {
            out = { ...out, usedBy: out.used ? { default: out.usedAt || Date.now() } : {} };
          }
          if (!Array.isArray(out.playlists)) out = { ...out, playlists: [] };
          return out;
        }));
      }
      if (lib.tags) setTags(lib.tags);
      if (lib.settings) {
        setSettings(lib.settings);
        if (typeof lib.settings.volume === "number") setVolume(lib.settings.volume);
      }
      setLoaded(true);
      // Remind the user which video project they're filing used tracks under.
      if (!lib.settings || lib.settings.askProjectOnOpen !== false) setProjectPrompt(true);
    })();
    (async () => {
      const b = await window.vf.bankList();
      setBank(b || []);
    })();
  }, []);

  // Persist any change to the library (skipped until the initial load finishes).
  useEffect(() => {
    if (!loaded) return;
    window.vf.saveLibrary({ tracks, tags, settings: { ...settings, volume } });
  }, [tracks, tags, settings, volume, loaded]);

  // Update the window/taskbar icon to match the chosen accent theme.
  useEffect(() => {
    if (window.vf.setIcon) window.vf.setIcon(accentName);
  }, [accentName]);

  // On startup, check GitHub for a newer release (silent if offline).
  useEffect(() => {
    (async () => {
      const latest = await fetchLatestRelease();
      if (latest && isNewer(latest, __APP_VERSION__)) setUpdateVersion(latest);
    })();
  }, []);

  // Keep the <audio> element's volume in sync with the slider + per-track gain.
  useEffect(() => {
    applyVolume(volume, selectedId);
  }, [volume, selectedId]);

  // Subscribe to <audio> events for the current track.
  useEffect(() => {
    const a = audioRef.current;
    if (!a) return;
    const onTime = () => setCurTime(a.currentTime);
    const onMeta = () => setDuration(a.duration);
    const onEnd = () => { setIsPlaying(false); playNextRef.current(); };
    a.addEventListener("timeupdate", onTime);
    a.addEventListener("loadedmetadata", onMeta);
    a.addEventListener("ended", onEnd);
    return () => {
      a.removeEventListener("timeupdate", onTime);
      a.removeEventListener("loadedmetadata", onMeta);
      a.removeEventListener("ended", onEnd);
    };
  }, [selectedId]);

  // Keyboard: Space = play/pause, Left/Right = seek ∓5s (ignored while typing/renaming).
  useEffect(() => {
    const onKey = (e) => {
      const el = document.activeElement;
      const tag = el && el.tagName;
      const typing = tag === "INPUT" || tag === "TEXTAREA" || (el && el.isContentEditable);
      if (typing || renaming || !selected) return;

      if (e.code === "Space" || e.key === " ") {
        e.preventDefault();
        togglePlay();
      } else if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
        const a = audioRef.current;
        if (!a) return;
        const dur = a.duration && isFinite(a.duration) ? a.duration : duration;
        if (!dur) return;
        e.preventDefault();
        const step = e.key === "ArrowRight" ? 5 : -5;
        const target = Math.min(dur, Math.max(0, a.currentTime + step));
        a.currentTime = target;
        setCurTime(target);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selected, isPlaying, duration, renaming]);

  // Track window size so the layout can adapt, throttled to one update per frame.
  useEffect(() => {
    let raf = null;
    const onResize = () => {
      if (raf) return;
      raf = requestAnimationFrame(() => { raf = null; setWinW(window.innerWidth); });
    };
    window.addEventListener("resize", onResize);
    return () => { window.removeEventListener("resize", onResize); if (raf) cancelAnimationFrame(raf); };
  }, []);

  // Escape closes the right-click menu.
  useEffect(() => {
    if (!ctxMenu) return;
    const onEsc = (e) => { if (e.key === "Escape") setCtxMenu(null); };
    window.addEventListener("keydown", onEsc);
    return () => window.removeEventListener("keydown", onEsc);
  }, [ctxMenu]);

  // Draw the waveform. `intro` (0..1) animates bars growing in a left-to-right
  // ripple; at 1 every bar is at full height.
  const drawWave = useCallback((intro = 1) => {
    const canvas = waveCanvasRef.current;
    if (!canvas || !Array.isArray(peaks)) return;
    const dpr = window.devicePixelRatio || 1;
    const cssW = canvas.clientWidth, cssH = canvas.clientHeight;
    // Nothing to draw if the panel has been collapsed to nothing.
    if (cssW <= 0 || cssH <= 0) return;
    canvas.width = Math.max(1, Math.round(cssW * dpr));
    canvas.height = Math.max(1, Math.round(cssH * dpr));
    const ctx = canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);

    const n = peaks.length;
    // Shrink the gap on very narrow panels so bars never end up with a
    // negative width (a negative arc radius throws and would blank the app).
    const gap = cssW / n > 3 ? 2 : 0;
    const barW = Math.max(0.5, (cssW - gap * (n - 1)) / n);
    const progress = duration ? curTime / duration : 0;
    const playedX = progress * cssW;

    const grad = ctx.createLinearGradient(0, 0, cssW, 0);
    grad.addColorStop(0, t.green);
    grad.addColorStop(1, t.orange);

    // Fraction of the total animation each bar takes; the rest is its staggered delay.
    const barSpan = 0.45;
    for (let i = 0; i < n; i++) {
      // Each bar's delay is based on its position (0 at left, up to 1-barSpan at right).
      const delay = (i / (n - 1 || 1)) * (1 - barSpan);
      let local = (intro - delay) / barSpan;       // this bar's own 0..1 progress
      local = Math.max(0, Math.min(1, local));
      const ease = 1 - Math.pow(1 - local, 3);      // ease-out cubic
      const fullH = Math.max(2, peaks[i] * cssH * 0.92);
      const h = Math.max(2, fullH * ease);
      const x = i * (barW + gap);
      const y = (cssH - h) / 2;
      const played = x + barW / 2 <= playedX;
      ctx.fillStyle = played ? grad : t.border;
      const r = Math.max(0, Math.min(barW / 2, 2)); // never negative
      ctx.beginPath();
      ctx.moveTo(x + r, y);
      ctx.arcTo(x + barW, y, x + barW, y + h, r);
      ctx.arcTo(x + barW, y + h, x, y + h, r);
      ctx.arcTo(x, y + h, x, y, r);
      ctx.arcTo(x, y, x + barW, y, r);
      ctx.closePath();
      ctx.fill();
    }
  }, [peaks, curTime, duration, t]);

  // Static redraw on progress/theme/peaks change, and whenever the window resizes
  // (the canvas is sized in pixels, so it must be re-rendered at the new width).
  useEffect(() => {
    if (introRafRef.current) return; // skip while a wave-in animation is running
    drawWave(1);
  }, [drawWave, winW]);

  // Trigger the left-to-right wave-in whenever a new track's peaks arrive.
  useEffect(() => {
    if (!Array.isArray(peaks)) return;
    if (introRafRef.current) cancelAnimationFrame(introRafRef.current);
    introStartRef.current = performance.now();
    const DURATION = 650; // ms for the full ripple
    const step = (now) => {
      const intro = Math.min(1, (now - introStartRef.current) / DURATION);
      drawWave(intro);
      if (intro < 1) {
        introRafRef.current = requestAnimationFrame(step);
      } else {
        introRafRef.current = null;
      }
    };
    introRafRef.current = requestAnimationFrame(step);
    return () => {
      if (introRafRef.current) { cancelAnimationFrame(introRafRef.current); introRafRef.current = null; }
    };
  }, [selectedId, peaks]);

  // ── 3. Playback ───────────────────────────────────────────────────────────
  // Effective volume = slider × per-track loudness gain, clamped to 0..1.
  const applyVolume = (sliderVol, trackId) => {
    const a = audioRef.current;
    if (!a) return;
    const gain = (trackId && gainCache.current[trackId]) || 1;
    // HTML audio `volume` is linear amplitude, but perceived loudness is roughly
    // logarithmic — a raw linear slider dumps most of its change into the bottom
    // end. Squaring the slider value makes the *perceived* change even.
    const perceptual = Math.pow(Math.max(0, Math.min(1, sliderVol)), 2);
    a.volume = Math.max(0, Math.min(1, perceptual * gain));
  };

  // Add files (used by the picker and by drag-in), de-duplicating by file path.
  // Imports always land in the library ("All tracks") regardless of which playlist
  // is open — use the right-click menu or bulk select to file them into playlists.
  const addTrackObjects = useCallback((objs) => {
    if (!objs || !objs.length) return;
    setTracks((prev) => {
      const existingPaths = new Set(prev.map((p) => p.filePath));
      const fresh = objs
        .filter((o) => !existingPaths.has(o.filePath))
        .map((o) => ({ ...o, usedBy: {}, playlists: [] }));
      return [...prev, ...fresh];
    });
  }, []);

  const pickFiles = async () => {
    const objs = await window.vf.pickFiles();
    addTrackObjects(objs);
  };

  const onDrop = async (e) => {
    e.preventDefault();
    setDragOver(false);
    const files = Array.from(e.dataTransfer.files || []);
    const paths = files.map((f) => window.vf.pathForFile(f)).filter(Boolean);
    if (paths.length) {
      // Dragging a track back into VibeFilter cancels its "used" mark.
      const dropped = new Set(paths);
      setTracks((prev) => prev.map((tr) =>
        isUsed(tr) && dropped.has(tr.filePath) ? markUsed(tr, false) : tr));
      const objs = await window.vf.processFiles(paths);
      addTrackObjects(objs); // already-known paths are ignored by addTrackObjects
    }
  };

  // Decode the audio once to build the waveform peaks and a loudness gain.
  const loadPeaks = useCallback(async (tr) => {
    if (peakCache.current[tr.id]) { setPeaks(peakCache.current[tr.id]); return; }
    setPeaks(null);
    try {
      const resp = await fetch(window.vf.fileUrl(tr.filePath));
      const arr = await resp.arrayBuffer();
      const AC = window.AudioContext || window.webkitAudioContext;
      const ctx = new AC();
      const audioBuf = await ctx.decodeAudioData(arr);
      const raw = audioBuf.getChannelData(0); // first channel is plenty
      const block = Math.floor(raw.length / WAVE_BARS) || 1;
      const out = new Array(WAVE_BARS).fill(0);
      let max = 0.0001;
      let totalSq = 0;
      for (let i = 0; i < WAVE_BARS; i++) {
        let sum = 0;
        const start = i * block;
        for (let j = 0; j < block; j++) {
          const v = raw[start + j] || 0;
          sum += v * v;
        }
        totalSq += sum;
        const rms = Math.sqrt(sum / block);
        out[i] = rms;
        if (rms > max) max = rms;
      }
      for (let i = 0; i < WAVE_BARS; i++) out[i] = out[i] / max; // normalize bars to 0..1

      // Whole-track RMS → gain that nudges every track toward a common loudness.
      const trackRms = Math.sqrt(totalSq / (WAVE_BARS * block)) || 0.0001;
      let gain = TARGET_RMS / trackRms;
      gain = Math.max(0.3, Math.min(3, gain)); // clamp so nothing is over-boosted or crushed
      gainCache.current[tr.id] = gain;

      ctx.close();
      peakCache.current[tr.id] = out;
      setSelectedId((cur) => {
        if (cur === tr.id) { setPeaks(out); applyVolume(volume, tr.id); }
        return cur;
      });
    } catch (e) {
      setPeaks("error");
    }
  }, [volume]);

  // Open a track in the player and start it playing.
  const selectTrack = (tr) => {
    setSelectedId(tr.id);
    setIsPlaying(false);
    setCurTime(0);
    setDuration(tr.durationSec || 0);
    if (audioRef.current) {
      const a = audioRef.current;
      a.src = window.vf.fileUrl(tr.filePath);
      a.load();
      applyVolume(volume, tr.id); // uses cached gain if available; loadPeaks refines it
      a.play().then(() => setIsPlaying(true)).catch(() => setIsPlaying(false));
    }
    loadPeaks(tr);
  };

  const togglePlay = () => {
    const a = audioRef.current;
    if (!a || !selected) return;
    if (isPlaying) {
      a.pause();
      setIsPlaying(false);
    } else {
      const dur = a.duration && isFinite(a.duration) ? a.duration : duration;
      if (dur && a.currentTime >= dur - 0.25) { // at the end → replay from start
        a.currentTime = 0;
        setCurTime(0);
      }
      a.play().then(() => setIsPlaying(true)).catch(() => {});
    }
  };

  const scrub = (e) => {
    const a = audioRef.current;
    if (!a) return;
    const dur = a.duration && isFinite(a.duration) ? a.duration : duration;
    if (!dur) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
    const target = ratio * dur;
    const applySeek = () => { a.currentTime = target; setCurTime(target); };
    if (a.readyState < 1 || a.seekable.length === 0) { // not seekable yet → wait
      const once = () => { applySeek(); a.removeEventListener("loadedmetadata", once); a.removeEventListener("canplay", once); };
      a.addEventListener("loadedmetadata", once);
      a.addEventListener("canplay", once);
    } else {
      applySeek();
    }
  };

  // ── 4. Library (tags, tracks, rename, filter & sort) ──────────────────────
  const toggleTrackTag = (trackId, tagId) => {
    setTracks((prev) =>
      prev.map((tr) =>
        tr.id === trackId
          ? { ...tr, tags: tr.tags.includes(tagId) ? tr.tags.filter((x) => x !== tagId) : [...tr.tags, tagId] }
          : tr
      )
    );
  };
  const randomTagColor = () => TAG_PALETTE[Math.floor(Math.random() * TAG_PALETTE.length)];
  const openAddTag = () => {
    setNewTag("");
    setNewTagColor(randomTagColor()); // suggest a random palette colour each time
    setAddTagOpen(true);
  };
  const addTag = () => {
    const label = newTag.trim();
    if (!label) return;
    const id = label.toLowerCase().replace(/\s+/g, "-") + "-" + Math.random().toString(36).slice(2, 5);
    setTags((prev) => [...prev, { id, label, color: newTagColor }]);
    setNewTag("");
    setAddTagOpen(false);
  };
  const setTagColor = (tagId, color) => {
    setTags((prev) => prev.map((tg) => (tg.id === tagId ? { ...tg, color } : tg)));
  };
  // Move a tag from one index to another (used by drag-to-reorder).
  const reorderTags = (from, to) => {
    if (from === to || from == null || to == null) return;
    setTags((prev) => {
      const next = [...prev];
      const [moved] = next.splice(from, 1);
      next.splice(to, 0, moved);
      return next;
    });
  };
  const removeTag = (tagId) => {
    setTags((prev) => prev.filter((tg) => tg.id !== tagId));
    setTracks((prev) => prev.map((tr) => ({ ...tr, tags: tr.tags.filter((x) => x !== tagId) })));
    setActiveFilters((prev) => prev.filter((x) => x !== tagId));
    setExcludedFilters((prev) => prev.filter((x) => x !== tagId));
  };

  // Filter chips are tri-state: neutral → included → (right-click) excluded.
  // Left click: an excluded chip becomes included; otherwise toggle neutral/included.
  const toggleFilter = (tagId) => {
    if (excludedFilters.includes(tagId)) {
      setExcludedFilters((prev) => prev.filter((x) => x !== tagId));
      setActiveFilters((prev) => (prev.includes(tagId) ? prev : [...prev, tagId]));
      return;
    }
    setActiveFilters((prev) => (prev.includes(tagId) ? prev.filter((x) => x !== tagId) : [...prev, tagId]));
  };
  // Right click: an excluded chip returns to neutral; otherwise it becomes excluded.
  const excludeFilter = (tagId) => {
    if (excludedFilters.includes(tagId)) {
      setExcludedFilters((prev) => prev.filter((x) => x !== tagId));
      return;
    }
    setActiveFilters((prev) => prev.filter((x) => x !== tagId));
    setExcludedFilters((prev) => [...prev, tagId]);
  };
  const clearFilters = () => { setActiveFilters([]); setExcludedFilters([]); setFavsOnly(false); };

  const toggleFavourite = (id) => {
    setTracks((prev) => prev.map((tr) =>
      tr.id === id ? { ...tr, favourite: !tr.favourite } : tr));
  };
  // Bulk favourite: favourite-first. If every selected track is already a
  // favourite, this unfavourites them all; otherwise it favourites them all.
  const selectedAllFav = tracks.length > 0 &&
    [...selectedTracks].length > 0 &&
    [...selectedTracks].every((id) => {
      const tr = tracks.find((x) => x.id === id);
      return tr && tr.favourite;
    });
  const favouriteSelected = () => {
    if (selectedTracks.size === 0) return;
    setTracks((prev) => prev.map((tr) =>
      selectedTracks.has(tr.id) ? { ...tr, favourite: !selectedAllFav } : tr));
  };

  const removeTrack = (id) => {
    if (selectedId === id) {
      const a = audioRef.current;
      if (a) { a.pause(); a.removeAttribute("src"); a.load(); }
      setIsPlaying(false);
      setCurTime(0);
      setDuration(0);
      setSelectedId(null);
    }
    setTracks((prev) => prev.filter((tr) => tr.id !== id));
  };

  const saveRename = () => {
    if (!renaming) return;
    const { trackId, title, artist } = renaming;
    setTracks((prev) => prev.map((tr) =>
      tr.id === trackId
        ? { ...tr, customTitle: title.trim() || null, customArtist: artist.trim() || null }
        : tr));
    setRenaming(null);
  };

  const removeSelectedTracks = () => {
    if (selectedTracks.size === 0) return;
    if (selectedId && selectedTracks.has(selectedId)) {
      const a = audioRef.current;
      if (a) { a.pause(); a.removeAttribute("src"); a.load(); }
      setIsPlaying(false);
      setCurTime(0);
      setDuration(0);
      setSelectedId(null);
    }
    setTracks((prev) => prev.filter((tr) => !selectedTracks.has(tr.id)));
    setSelectedTracks(new Set());
  };

  // Tracks matching the active search + tag filters, sorted by artist then title.
  const filtered = tracks
    .filter((tr) => {
      const { title, artist } = parseName(tr);
      const hay = (title + " " + (artist || "") + " " + tr.name).toLowerCase();
      const matchSearch = hay.includes(search.toLowerCase());
      const matchTags = activeFilters.every((f) => tr.tags.includes(f));
      const matchExcluded = excludedFilters.every((f) => !tr.tags.includes(f));
      const matchFavs = !favsOnly || tr.favourite;
      const matchUsed = !hideUsed || !isUsed(tr);
      const matchPlaylist = inPlaylist(tr, activePlaylist);
      return matchSearch && matchTags && matchExcluded && matchFavs && matchUsed && matchPlaylist;
    })
    .sort((a, b) => {
      const pa = parseName(a), pb = parseName(b);
      const aKey = (pa.artist || "\uffff").toLowerCase();
      const bKey = (pb.artist || "\uffff").toLowerCase();
      const byArtist = aKey.localeCompare(bKey, undefined, { sensitivity: "base" });
      if (byArtist !== 0) return byArtist;
      return pa.title.localeCompare(pb.title, undefined, { sensitivity: "base" });
    });

  const tagById = (id) => tags.find((tg) => tg.id === id);

  // Total duration of the whole library, rounded to whole minutes.
  const totalMinutes = Math.round(tracks.reduce((sum, tr) => sum + (tr.durationSec || 0), 0) / 60);
  const usedCount = tracks.filter((tr) => isUsed(tr)).length;

  // Credited tracks for the active project, in the order they were used.
  // A saved custom order (from dragging in the credits editor) takes priority;
  // anything not in that list falls in afterwards by use time.
  const creditTracks = (() => {
    const list = tracks.filter((tr) => isUsed(tr) && !tr.noCredit);
    const saved = (settings.creditOrder || {})[activeProfile] || [];
    const rank = new Map(saved.map((id, i) => [id, i]));
    return list.sort((a, b) => {
      const ra = rank.has(a.id) ? rank.get(a.id) : Infinity;
      const rb = rank.has(b.id) ? rank.get(b.id) : Infinity;
      if (ra !== rb) return ra - rb;
      return usedAtFor(a) - usedAtFor(b); // otherwise: order of use
    });
  })();
  const creditCount = creditTracks.length;
  const creditsText = () =>
    creditTracks
      .map((tr) => parseName(tr))
      .map(({ title, artist }) => (artist ? `${artist} — ${title}` : title))
      .join("\n");
  // Persist a new credit order for the active project.
  const saveCreditOrder = (ids) => setSettings((p) => ({
    ...p, creditOrder: { ...(p.creditOrder || {}), [activeProfile]: ids },
  }));
  const toggleNoCredit = (id) => {
    setTracks((prev) => prev.map((tr) => (tr.id === id ? { ...tr, noCredit: !tr.noCredit } : tr)));
  };

  const copyCredits = async () => {
    const text = creditsText();
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      setCreditsCopied(true);
      setTimeout(() => setCreditsCopied(false), 1800);
    } catch {
      setCreditsCopied(false);
    }
  };

  // Track counts grouped by artist/game, most tracks first (for the Settings stats).
  const artistCounts = (() => {
    const counts = {};
    for (const tr of tracks) {
      const { artist } = parseName(tr);
      const key = artist || "Unknown";
      counts[key] = (counts[key] || 0) + 1;
    }
    return Object.entries(counts).sort((a, b) => b[1] - a[1]);
  })();

  // Pick a random track from the current filtered view and play it.
  const shuffle = () => {
    if (selectMode) return;
    const pool = filtered;
    if (pool.length === 0) return;
    let pick = pool[Math.floor(Math.random() * pool.length)];
    // Avoid repeating the current track when there's more than one option.
    if (pool.length > 1 && pick.id === selectedId) {
      const others = pool.filter((tr) => tr.id !== selectedId);
      pick = others[Math.floor(Math.random() * others.length)];
    }
    selectTrack(pick);
  };

  // What happens when a track finishes, per the loop mode.
  const playNext = () => {
    // "one" repeats the current track.
    if (loopMode === "one") {
      const a = audioRef.current;
      if (a) { a.currentTime = 0; setCurTime(0); a.play().then(() => setIsPlaying(true)).catch(() => {}); }
      return;
    }
    const pool = filtered;
    if (pool.length === 0) return;
    const idx = pool.findIndex((tr) => tr.id === selectedId);
    if (idx === -1) { selectTrack(pool[0]); return; }
    const atEnd = idx === pool.length - 1;
    if (atEnd && loopMode === "off") return; // stop at the end
    selectTrack(pool[(idx + 1) % pool.length]);
  };
  // Keep the ref current so the <audio> "ended" handler always calls the
  // latest version (with up-to-date filtered list and selection).
  playNextRef.current = playNext;

  // Effective cover for a track: an explicitly assigned bank cover wins (lets you
  // override embedded art), then embedded art, then none.
  const coverUrlFor = (tr) => {
    if (tr.assignedCover) {
      const found = bank.find((b) => b.id === tr.assignedCover);
      if (found) return window.vf.fileUrl(found.path);
    }
    if (tr.coverPath) return window.vf.fileUrl(tr.coverPath);
    return null;
  };

  // ── 5. Cover bank (upload / assign / remove cover art) ────────────────────
  const addToBank = async () => {
    const added = await window.vf.bankAdd();
    if (added && added.length) setBank((prev) => [...prev, ...added]);
  };
  const deleteFromBank = async (id) => {
    await window.vf.bankDelete(id);
    setBank((prev) => prev.filter((b) => b.id !== id));
    // Unassign from any tracks that used it
    setTracks((prev) => prev.map((tr) =>
      tr.assignedCover === id ? { ...tr, assignedCover: null } : tr));
  };
  const assignCoverToSelected = (bankId) => {
    setTracks((prev) => prev.map((tr) =>
      selectedTracks.has(tr.id) ? { ...tr, assignedCover: bankId } : tr));
    setBankOpen(false);
    setSelectMode(false);
    setSelectedTracks(new Set());
  };
  const assignCoverToOne = (trackId, bankId) => {
    setTracks((prev) => prev.map((tr) =>
      tr.id === trackId ? { ...tr, assignedCover: bankId } : tr));
  };

  // ── 6. Selection (multi-select for bulk actions) + drag-out ───────────────
  const toggleSelect = (id) => {
    setSelectedTracks((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };
  const selectAllWithoutCover = () => {
    setSelectedTracks(new Set(filtered.filter((tr) => !coverUrlFor(tr)).map((tr) => tr.id)));
  };
  const exitSelectMode = () => { setSelectMode(false); setSelectedTracks(new Set()); };

  // Render a small "card" of the track (cover + title) to a data URL, so the OS
  // drag shows the card instead of a generic file icon. Falls back to null.
  const buildDragImage = (tileEl, tr) => {
    try {
      const W = 180, H = 180;
      const canvas = document.createElement("canvas");
      canvas.width = W; canvas.height = H;
      const ctx = canvas.getContext("2d");
      const r = 14;
      // rounded card background
      ctx.beginPath();
      ctx.moveTo(r, 0);
      ctx.arcTo(W, 0, W, H, r); ctx.arcTo(W, H, 0, H, r);
      ctx.arcTo(0, H, 0, 0, r); ctx.arcTo(0, 0, W, 0, r);
      ctx.closePath();
      ctx.fillStyle = t.bgCard;
      ctx.fill();
      ctx.save();
      ctx.clip();
      // cover art, taken from the tile's already-loaded <img>
      const img = tileEl && tileEl.querySelector("img");
      if (img && img.complete && img.naturalWidth) {
        ctx.drawImage(img, 0, 0, W, H - 34);
      } else {
        const g = ctx.createLinearGradient(0, 0, W, H);
        g.addColorStop(0, t.green); g.addColorStop(1, t.orange);
        ctx.fillStyle = g;
        ctx.fillRect(0, 0, W, H - 34);
      }
      // title strip
      ctx.fillStyle = t.bgCard;
      ctx.fillRect(0, H - 34, W, 34);
      ctx.fillStyle = t.text;
      ctx.font = "600 13px 'DM Sans', system-ui, sans-serif";
      const { title } = parseName(tr);
      let label = title;
      while (ctx.measureText(label).width > W - 20 && label.length > 1) label = label.slice(0, -1);
      if (label !== title) label = label.slice(0, -1) + "…";
      ctx.fillText(label, 10, H - 13);
      ctx.restore();
      // accent border
      ctx.strokeStyle = t.green;
      ctx.lineWidth = 2;
      ctx.stroke();
      return canvas.toDataURL("image/png");
    } catch {
      return null; // tainted canvas or anything unexpected — use the default icon
    }
  };

  // Hand a track off to the OS so it can be dragged into Premiere / Explorer,
  // and mark it "used" so it can be hidden until the user resets.
  const onTrackDragStart = (e, tr) => {
    e.preventDefault();
    if (selectMode) return; // no dragging out while bulk-selecting
    const dragImage = buildDragImage(e.currentTarget, tr);
    window.vf.startDrag(tr.filePath, dragImage);
    // usedAt lets "Undo use" find the most recently used track, even after a restart.
    setTracks((prev) => prev.map((x) => (x.id === tr.id ? markUsed(x, true) : x)));
  };
  // Clear every used mark for the active video profile only.
  const resetUsed = () => {
    setTracks((prev) => prev.map((tr) => (isUsed(tr) ? markUsed(tr, false) : tr)));
  };
  // Mark a single track used / unused for the active profile.
  const setTrackUsed = (id, used) => {
    setTracks((prev) => prev.map((tr) => (tr.id === id ? markUsed(tr, used) : tr)));
  };
  // Un-use whichever track was used most recently in this profile.
  const undoLastUse = () => {
    const used = tracks.filter((tr) => isUsed(tr));
    if (used.length === 0) return;
    const latest = used.reduce((a, b) => (usedAtFor(b) > usedAtFor(a) ? b : a));
    setTrackUsed(latest.id, false);
  };

  // Create a playlist or video profile from the "New…" dialog, then switch to it.
  const createNewItem = () => {
    if (!newItem) return;
    const name = newItem.name.trim();
    if (!name) return;
    const id = `${newItem.kind}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
    if (newItem.kind === "playlist") {
      const assignTo = newItem.assignTo || null;
      setSettings((p) => ({
        ...p,
        playlists: [...(p.playlists || []), { id, name }],
        // Only jump to the new playlist when it wasn't created to file tracks into.
        activePlaylist: assignTo ? p.activePlaylist || "all" : id,
      }));
      if (assignTo) setPlaylistMembership(assignTo, id, true);
    } else {
      setSettings((p) => ({
        ...p,
        profiles: [...(p.profiles && p.profiles.length ? p.profiles : [{ id: "default", name: "Default project" }]), { id, name }],
        activeProfile: id,
      }));
    }
    setNewItem(null);
  };

  // Remove the active playlist (tracks stay in the library) or profile.
  // Remove a playlist by id (tracks stay in the library).
  const deletePlaylist = (plId) => {
    setTracks((prev) => prev.map((tr) =>
      (tr.playlists || []).includes(plId)
        ? { ...tr, playlists: tr.playlists.filter((x) => x !== plId) }
        : tr));
    setSettings((p) => ({
      ...p,
      playlists: (p.playlists || []).filter((pl) => pl.id !== plId),
      activePlaylist: p.activePlaylist === plId ? "all" : p.activePlaylist,
    }));
  };
  // Remove a video project by id, clearing only that project's used marks.
  const deleteProfile = (pfId) => {
    if (profiles.length <= 1) return;
    setTracks((prev) => prev.map((tr) => {
      if (!tr.usedBy || !(pfId in tr.usedBy)) return tr;
      const usedBy = { ...tr.usedBy };
      delete usedBy[pfId];
      return { ...tr, usedBy };
    }));
    const remaining = profiles.filter((pf) => pf.id !== pfId);
    setSettings((p) => ({
      ...p,
      profiles: remaining,
      activeProfile: p.activeProfile === pfId ? remaining[0].id : p.activeProfile,
    }));
  };
  // Rename a playlist or project in place.
  const renamePlaylist = (plId, name) => setSettings((p) => ({
    ...p, playlists: (p.playlists || []).map((pl) => (pl.id === plId ? { ...pl, name } : pl)),
  }));
  const renameProfile = (pfId, name) => setSettings((p) => ({
    ...p,
    profiles: (p.profiles && p.profiles.length ? p.profiles : profiles)
      .map((pf) => (pf.id === pfId ? { ...pf, name } : pf)),
  }));

  // Playlist membership for any set of tracks (one track, or a bulk selection).
  const setPlaylistMembership = (trackIds, plId, member) => {
    const ids = new Set(trackIds);
    setTracks((prev) => prev.map((tr) => {
      if (!ids.has(tr.id)) return tr;
      const cur = tr.playlists || [];
      if (member && !cur.includes(plId)) return { ...tr, playlists: [...cur, plId] };
      if (!member && cur.includes(plId)) return { ...tr, playlists: cur.filter((x) => x !== plId) };
      return tr;
    }));
  };
  // True when every given track is already in the playlist.
  const allInPlaylist = (trackIds, plId) =>
    trackIds.length > 0 && trackIds.every((id) => {
      const tr = tracks.find((x) => x.id === id);
      return tr && (tr.playlists || []).includes(plId);
    });
  const removeFromPlaylist = (id) => {
    if (activePlaylist === "all") return;
    setPlaylistMembership([id], activePlaylist, false);
  };

  // ── 7. Render ─────────────────────────────────────────────────────────────
  const s = makeStyles(t);
  const empty = tracks.length === 0;
  const tileMin = { small: 110, medium: 160, large: 230 }[tileSize];

  // Responsive panel sizing: shrink the side panels as the window narrows so the
  // track grid keeps as much room as possible.
  const compact = winW < 1100;
  const veryCompact = winW < 900;
  const sidebarW = veryCompact ? 210 : compact ? 240 : 280;
  const playerW = veryCompact ? 250 : compact ? 290 : 340;

  // Colours for pie slices: alternate the two accent colours plus a few neutrals
  // so adjacent slices stay distinguishable even with many artists.
  const SLICE_COLORS = [t.green, t.orange, "#a78bfa", "#34d399", "#facc15",
    "#38bdf8", "#fb7185", "#c084fc", "#22d3ee", "#fb923c"];
  // Build an SVG arc path for a pie slice from startAngle to endAngle (radians).
  const arcPath = (cx, cy, r, startAngle, endAngle) => {
    const x1 = cx + r * Math.cos(startAngle), y1 = cy + r * Math.sin(startAngle);
    const x2 = cx + r * Math.cos(endAngle), y2 = cy + r * Math.sin(endAngle);
    const largeArc = endAngle - startAngle > Math.PI ? 1 : 0;
    return `M ${cx} ${cy} L ${x1} ${y1} A ${r} ${r} 0 ${largeArc} 1 ${x2} ${y2} Z`;
  };

  return (
    <div style={s.app}>
      <link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700&display=swap" rel="stylesheet" />
      <GlobalStyles t={t} />
      <audio ref={audioRef} />

      <aside className="vf-scroll" style={{ ...s.sidebar, width: sidebarW, minWidth: sidebarW }}>
        <div style={s.logo}>
          <img src={accentIcon} alt="VibeFilter" style={{ width: 34, height: 34, borderRadius: 9 }} />
          <div>
            <div style={{ fontSize: 16, fontWeight: 700, letterSpacing: -0.3 }}>VibeFilter</div>
          </div>
        </div>

        <div style={s.section}>
          <div style={s.label}>Video project</div>
          <Dropdown t={t} icon={ICONS.film} width="100%"
            value={activeProfile}
            options={profiles.map((pf) => ({
              ...pf,
              count: tracks.filter((tr) => tr.usedBy && tr.usedBy[pf.id]).length,
            }))}
            onSelect={setActiveProfile}
            onAddNew={() => setNewItem({ kind: "profile", name: "" })}
            addNewLabel="New project" />
        </div>

        <div style={s.section}>
          <div style={s.label}>Filter by vibe</div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 7 }}>
            <span className="vf-chip" style={{ ...s.chip(favsOnly, "#facc15"), padding: "5px 9px" }}
              title="Show only favourites"
              onClick={() => setFavsOnly((v) => !v)}>
              <Icon d={ICONS.star} size={14} fill={favsOnly ? "currentColor" : "none"} />
            </span>
            {tags.map((tg) => {
              const included = activeFilters.includes(tg.id);
              const excluded = excludedFilters.includes(tg.id);
              return (
                <span key={tg.id} className="vf-chip"
                  title={excluded
                    ? "Excluded — left click to include, right click to reset"
                    : included
                    ? "Included — left click to reset, right click to exclude"
                    : "Left click to include, right click to exclude"}
                  style={{
                    ...s.chip(included, tg.color),
                    ...(excluded ? {
                      background: "transparent",
                      color: tg.color,
                      border: `1px dashed ${tg.color}`,
                      textDecoration: "line-through",
                      opacity: 0.85,
                    } : {}),
                  }}
                  onClick={() => toggleFilter(tg.id)}
                  onContextMenu={(e) => { e.preventDefault(); excludeFilter(tg.id); }}>
                  {tg.label}
                </span>
              );
            })}
            {tags.length === 0 && (
              <span style={{ fontSize: 12.5, color: t.textDim, alignSelf: "center" }}>No tags yet.</span>
            )}
          </div>
          {(() => {
            const anyFilter = activeFilters.length > 0 || excludedFilters.length > 0 || favsOnly || search;
            return (
              <button onClick={() => { clearFilters(); setSearch(""); }} disabled={!anyFilter}
                style={{ marginTop: 10, width: "100%", display: "inline-flex", alignItems: "center",
                  justifyContent: "center", gap: 7, padding: "7px 10px", borderRadius: 8,
                  fontFamily: "inherit", fontSize: 12.5, fontWeight: 600,
                  cursor: anyFilter ? "pointer" : "not-allowed",
                  border: `1px solid ${anyFilter ? t.green : t.border}`,
                  background: anyFilter ? t.accentBg : "transparent",
                  color: anyFilter ? t.green : t.textDim }}>
                <Icon d={ICONS.x} size={13} /> Clear filters
              </button>
            );
          })()}
          <div style={{ marginTop: 12, display: "flex", alignItems: "center", gap: 7, flexWrap: "wrap" }}>
            <span onClick={() => setHideUsed((v) => !v)}
              title={hideUsed ? "Used tracks are hidden" : "Used tracks are shown"}
              className="vf-chip" style={{ ...s.chip(hideUsed, t.green), padding: "5px 10px", gap: 6 }}>
              <Icon d={ICONS.check} size={13} /> Hide used
            </span>
            {usedCount > 0 && (
              <span onClick={undoLastUse} title="Un-use the most recently used track"
                className="vf-chip" style={{ ...s.chip(false, t.green), padding: "5px 10px", gap: 6 }}>
                <Icon d={ICONS.undo} size={13} /> Undo use
              </span>
            )}
            {usedCount > 0 && (
              <span onClick={resetUsed}
                style={{ fontSize: 12, color: t.green, cursor: "pointer", fontWeight: 600 }}>
                Reset used ({usedCount})
              </span>
            )}
          </div>
        </div>

        <div style={s.section}>
          <div style={s.label}>Manage tags</div>
          <button onClick={() => setTagsOpen(true)}
            style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 7,
              width: "100%", padding: "8px 10px", borderRadius: 8,
              border: `1px solid ${t.border}`, background: t.bgCard2, color: t.text,
              cursor: "pointer", fontSize: 13, fontWeight: 600, fontFamily: "inherit" }}>
            <Icon d={ICONS.tagIcon} size={15} /> Manage tags ({tags.length})
          </button>
          <button onClick={() => setCreditsOpen(true)} disabled={creditCount === 0}
            style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 7,
              width: "100%", padding: "8px 10px", marginTop: 8, borderRadius: 8,
              border: `1px solid ${t.border}`,
              background: creditCount ? t.bgCard2 : "transparent",
              color: creditCount ? t.text : t.textDim,
              cursor: creditCount ? "pointer" : "not-allowed",
              fontSize: 13, fontWeight: 600, fontFamily: "inherit" }}>
            <Icon d={ICONS.clipboard} size={15} /> Credits ({creditCount})
          </button>
        </div>

        <div style={{ marginTop: "auto", padding: 18, display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10 }}>
          <span style={{ fontSize: 12, color: t.textDim, whiteSpace: "nowrap",
            overflow: "hidden", textOverflow: "ellipsis", minWidth: 0 }}>
            {tracks.length} track{tracks.length !== 1 ? "s" : ""} · {totalMinutes} min
          </span>
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
            <div style={{ display: "flex", height: 34, borderRadius: 8, overflow: "hidden",
              border: `1px solid ${t.border}`, flexShrink: 0 }}>
              {["small", "medium", "large"].map((size) => (
                <button key={size} title={`${size[0].toUpperCase()}${size.slice(1)} tiles`}
                  onClick={() => setTileSize(size)}
                  style={{
                    border: "none", cursor: "pointer", padding: "0 9px",
                    fontSize: 12, fontWeight: 700, fontFamily: "inherit",
                    background: tileSize === size ? t.green : t.bgCard2,
                    color: tileSize === size ? "#fff" : t.textMuted }}>
                  {size[0].toUpperCase()}
                </button>
              ))}
            </div>
            <TooltipButton label="Settings" t={t}
              onClick={() => setSettingsOpen(true)}
              style={{ ...s.iconBtn, width: 34, height: 34, flexShrink: 0 }}>
              <Icon d={ICONS.settings} size={16} />
            </TooltipButton>
          </div>
        </div>
      </aside>

      <div style={s.main}>
        {updateVersion && !updateDismissed && (
          <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "10px 24px",
            background: t.accentBg, borderBottom: `1px solid ${t.green}`, fontSize: 13 }}>
            <Icon d={ICONS.upload} size={15} />
            <span style={{ flex: 1, color: t.text }}>
              A new version of VibeFilter ({updateVersion}) is available.
            </span>
            <button onClick={() => window.vf.openUrl(REPO_URL)}
              style={{ padding: "6px 12px", borderRadius: 8, border: "none", cursor: "pointer",
                background: t.green, color: "#fff", fontSize: 12.5, fontWeight: 600, fontFamily: "inherit" }}>
              View on GitHub
            </button>
            <span onClick={() => setUpdateDismissed(true)} title="Dismiss"
              style={{ cursor: "pointer", color: t.textMuted, display: "grid", placeItems: "center" }}>
              <Icon d={ICONS.x} size={16} />
            </span>
          </div>
        )}
        <div style={s.topbar}>
          <Dropdown t={t} icon={ICONS.playlist}
            width={compact ? 140 : 180}
            value={activePlaylist}
            options={[
              { ...ALL_PLAYLIST, count: tracks.length },
              ...playlists.map((pl) => ({
                ...pl,
                count: tracks.filter((tr) => inPlaylist(tr, pl.id)).length,
              })),
            ]}
            onSelect={setActivePlaylist}
            onAddNew={() => setNewItem({ kind: "playlist", name: "" })}
            addNewLabel="New playlist" />
          <div style={s.searchWrap}>
            <Icon d={ICONS.search} size={16} />
            <input style={s.searchInput} placeholder="Search tracks…"
              value={search} onChange={(e) => setSearch(e.target.value)} />
          </div>
          <TooltipButton label="Shuffle" t={t}
            disabled={filtered.length === 0 || selectMode}
            onClick={shuffle}
            style={{ ...s.iconBtn, ...(filtered.length === 0 || selectMode ? { opacity: 0.5, cursor: "not-allowed" } : {}) }}>
            <Icon d={ICONS.shuffle} size={16} />
          </TooltipButton>
          <TooltipButton label={selectMode ? "Exit select mode" : "Select tracks"} t={t}
            onClick={() => (selectMode ? exitSelectMode() : setSelectMode(true))}
            style={{ ...s.iconBtn, ...(selectMode ? { background: t.green, color: "#fff", border: `1px solid ${t.green}` } : {}) }}>
            <Icon d={ICONS.check} size={16} />
          </TooltipButton>
          <TooltipButton label="Cover bank" t={t}
            onClick={() => setBankOpen(true)} style={s.iconBtn}>
            <Icon d={ICONS.image} size={16} />
          </TooltipButton>
          <TooltipButton label="Add files" t={t}
            onClick={pickFiles} style={s.iconBtn}>
            <Icon d={ICONS.upload} size={16} />
          </TooltipButton>
        </div>

        {selectMode && (
          <div style={{ padding: "10px 24px", borderBottom: `1px solid ${t.border}`,
            background: t.bgCard, display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
            <span style={{ fontSize: 13, fontWeight: 600 }}>
              {selectedTracks.size} selected
            </span>
            <button onClick={selectAllWithoutCover}
              style={{ fontSize: 12.5, fontWeight: 600, color: t.green, background: "none",
                border: "none", cursor: "pointer", fontFamily: "inherit" }}>
              Select all without a cover
            </button>
            <div style={{ flex: 1 }} />
            <button onClick={favouriteSelected} disabled={selectedTracks.size === 0}
              style={{ display: "inline-flex", alignItems: "center", gap: 7, padding: "7px 14px",
                borderRadius: 8, border: "none", fontFamily: "inherit", fontSize: 13, fontWeight: 600,
                cursor: selectedTracks.size ? "pointer" : "not-allowed",
                background: selectedTracks.size ? "#facc15" : t.bgCard2,
                color: selectedTracks.size ? "#1a1a1a" : t.textDim }}>
              <Icon d={ICONS.star} size={15} fill="currentColor" /> {selectedAllFav ? "Unfavourite selected" : "Favourite selected"}
            </button>
            <button onClick={() => setPlaylistPicker({ trackIds: [...selectedTracks] })}
              disabled={selectedTracks.size === 0}
              style={{ display: "inline-flex", alignItems: "center", gap: 7, padding: "7px 14px",
                borderRadius: 8, fontFamily: "inherit", fontSize: 13, fontWeight: 600,
                cursor: selectedTracks.size ? "pointer" : "not-allowed", background: "transparent",
                border: `1px solid ${selectedTracks.size ? t.green : t.border}`,
                color: selectedTracks.size ? t.green : t.textDim }}>
                <Icon d={ICONS.playlist} size={15} /> Add to playlist
              </button>
            <button onClick={() => setBankOpen(true)} disabled={selectedTracks.size === 0}
              style={{ display: "inline-flex", alignItems: "center", gap: 7, padding: "7px 14px",
                borderRadius: 8, border: "none", fontFamily: "inherit", fontSize: 13, fontWeight: 600,
                cursor: selectedTracks.size ? "pointer" : "not-allowed",
                background: selectedTracks.size ? t.green : t.bgCard2,
                color: selectedTracks.size ? "#fff" : t.textDim }}>
              <Icon d={ICONS.image} size={15} /> Apply cover to selected
            </button>
            <button onClick={removeSelectedTracks} disabled={selectedTracks.size === 0}
              onMouseEnter={(e) => { if (selectedTracks.size) { e.currentTarget.style.background = t.red; e.currentTarget.style.color = "#fff"; e.currentTarget.style.borderColor = t.red; } }}
              onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; e.currentTarget.style.color = selectedTracks.size ? t.red : t.textDim; e.currentTarget.style.borderColor = selectedTracks.size ? t.red : t.border; }}
              style={{ display: "inline-flex", alignItems: "center", gap: 7, padding: "7px 14px",
                borderRadius: 8, fontFamily: "inherit", fontSize: 13, fontWeight: 600,
                cursor: selectedTracks.size ? "pointer" : "not-allowed",
                background: "transparent", transition: "background 0.15s, color 0.15s, border-color 0.15s",
                border: `1px solid ${selectedTracks.size ? t.red : t.border}`,
                color: selectedTracks.size ? t.red : t.textDim }}>
              <Icon d={ICONS.trash} size={15} /> Delete selected
            </button>
            <button onClick={exitSelectMode}
              style={{ fontSize: 12.5, fontWeight: 600, color: t.textMuted, background: "none",
                border: "none", cursor: "pointer", fontFamily: "inherit" }}>
              Done
            </button>
          </div>
        )}

        <div style={s.content}>
          <div className="vf-scroll"
            style={{ ...s.list,
              outline: dragOver && !empty ? `3px solid ${t.green}` : "3px solid transparent",
              outlineOffset: -3, borderRadius: 12, transition: "outline-color 0.12s" }}
            onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
            onDragLeave={() => setDragOver(false)}
            onDrop={onDrop}>
            {empty ? (
              <div style={{
                height: "100%", border: `2px dashed ${dragOver ? t.green : t.border}`,
                borderRadius: 16, display: "flex", flexDirection: "column",
                alignItems: "center", justifyContent: "center", gap: 14,
                color: t.textMuted, background: dragOver ? t.accentBg : "transparent",
              }}>
                <div style={{ ...s.logoMark, width: 56, height: 56, borderRadius: 16 }}>
                  <Icon d={ICONS.upload} size={26} />
                </div>
                <div style={{ fontSize: 17, fontWeight: 600, color: t.text }}>Drop your music here</div>
                <div style={{ fontSize: 13.5 }}>MP3, WAV, M4A, FLAC and more — or click the upload button.</div>
              </div>
            ) : (
              <>
                {filtered.length === 0 ? (
                  <div style={{ color: t.textMuted, fontSize: 14, padding: 20 }}>
                    No tracks match these filters.
                  </div>
                ) : (
                  <div style={{ ...s.grid, gridTemplateColumns: `repeat(auto-fill, minmax(${tileMin}px, 1fr))` }}>
                    {filtered.map((tr) => {
                      const active = tr.id === selectedId;
                      const isSel = selectedTracks.has(tr.id);
                      const { title, artist } = parseName(tr);
                      const coverUrl = coverUrlFor(tr);
                      const cardClick = () => {
                        if (selectMode) toggleSelect(tr.id);
                        else selectTrack(tr);
                      };
                      return (
                        <div key={tr.id}
                          className="vf-tile"
                          tabIndex={-1}
                          style={{
                            ...s.trackCard(active),
                            ...(selectMode && isSel
                              ? { border: `1px solid ${t.green}`, background: t.accentBg }
                              : {}),
                            cursor: selectMode ? "pointer" : "grab",
                            outline: "none",
                            opacity: isUsed(tr) && !active ? 0.45 : 1,
                          }}
                          draggable={!selectMode}
                          onDragStart={(e) => onTrackDragStart(e, tr)}
                          onContextMenu={(e) => {
                            e.preventDefault();
                            setCtxMenu({ x: e.clientX, y: e.clientY, trackId: tr.id });
                          }}
                          onClick={cardClick}>
                          <div style={{ position: "relative", marginBottom: 10 }}>
                            {coverUrl
                              ? <img src={coverUrl} alt="" style={{ ...s.cover, marginBottom: 0 }} />
                              : <div style={{ ...s.cover, marginBottom: 0 }}><Icon d={ICONS.music} size={28} /></div>}
                            {selectMode && (
                              <div style={{
                                position: "absolute", top: 8, left: 8, width: 24, height: 24,
                                borderRadius: "50%", display: "grid", placeItems: "center",
                                background: isSel ? t.green : "rgba(0,0,0,0.45)",
                                border: `2px solid ${isSel ? t.green : "#fff"}`, color: "#fff" }}>
                                {isSel && <Icon d={ICONS.check} size={14} />}
                              </div>
                            )}
                            {tr.favourite && (
                              <div style={{
                                position: "absolute", top: 8, right: 8, width: 24, height: 24,
                                borderRadius: "50%", display: "grid", placeItems: "center",
                                background: "rgba(0,0,0,0.45)", color: "#facc15" }}>
                                <Icon d={ICONS.star} size={14} fill="currentColor" />
                              </div>
                            )}
                            {!selectMode && isUsed(tr) && (
                              <div title="Used"
                                style={{
                                  position: "absolute", top: 8, left: 8, width: 24, height: 24,
                                  borderRadius: "50%", display: "grid", placeItems: "center",
                                  background: t.green, color: "#fff", boxShadow: "0 1px 4px rgba(0,0,0,0.35)" }}>
                                <Icon d={ICONS.check} size={14} />
                              </div>
                            )}
                          </div>
                          <div style={{ minWidth: 0 }}>
                            <div style={{ fontSize: 13.5, fontWeight: 600, whiteSpace: "nowrap",
                              overflow: "hidden", textOverflow: "ellipsis" }}>{title}</div>
                            {artist && (
                              <div style={{ fontSize: 11.5, color: t.textMuted, marginTop: 1,
                                whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{artist}</div>
                            )}
                            <div style={{ display: "flex", alignItems: "center", gap: 5, marginTop: 8, minHeight: 11 }}>
                              {tr.tags.length === 0 ? (
                                <span style={{ fontSize: 10.5, color: t.textDim }}>No tags</span>
                              ) : tr.tags.map((tagId) => {
                                const tg = tagById(tagId);
                                if (!tg) return null;
                                return (
                                  <span key={tagId} title={tg.label}
                                    style={{ width: 10, height: 10, borderRadius: "50%",
                                      background: tg.color, flexShrink: 0,
                                      boxShadow: `0 0 0 2px ${t.bgCard}` }} />
                                );
                              })}
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </>
            )}
          </div>

          <aside style={{ ...s.player, width: playerW, minWidth: playerW }} className="vf-scroll">
            <div style={s.label}>Now previewing</div>
            {selected ? (
              <>
                <div style={{
                  width: "100%", aspectRatio: "1 / 1", flexShrink: 0,
                  borderRadius: 16, overflow: "hidden",
                  background: `linear-gradient(135deg, ${t.greenBg}, ${t.orangeBg})`,
                  display: "grid", placeItems: "center", marginBottom: 18,
                  border: `1px solid ${t.border}`,
                }}>
                  {coverUrlFor(selected)
                    ? <img src={coverUrlFor(selected)} alt=""
                        style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }} />
                    : <Icon d={ICONS.music} size={48} />}
                </div>

                {(() => { const { title, artist } = parseName(selected); return (
                  <>
                    <div onClick={() => setRenaming({ trackId: selected.id, title: title || "", artist: artist || "" })}
                      title="Click to rename"
                      onMouseEnter={(e) => (e.currentTarget.style.textDecoration = "underline")}
                      onMouseLeave={(e) => (e.currentTarget.style.textDecoration = "none")}
                      style={{ fontSize: 17, fontWeight: 700, letterSpacing: -0.3, marginBottom: 2,
                        cursor: "pointer" }}>{title}</div>
                    <div onClick={() => setRenaming({ trackId: selected.id, title: title || "", artist: artist || "" })}
                      title="Click to rename"
                      onMouseEnter={(e) => (e.currentTarget.style.textDecoration = "underline")}
                      onMouseLeave={(e) => (e.currentTarget.style.textDecoration = "none")}
                      style={{ fontSize: 12.5, color: t.textDim, marginBottom: 18, cursor: "pointer",
                        display: "inline-block" }}>{artist || selected.fileName}</div>
                  </>
                ); })()}

                {Array.isArray(peaks) ? (
                  <canvas ref={waveCanvasRef} onClick={scrub}
                    style={{ width: "100%", height: 64, cursor: "pointer", display: "block",
                      marginBottom: 8 }} />
                ) : (
                  <div onClick={scrub}
                    style={{ height: 64, borderRadius: 10, background: t.bgCard2, cursor: "pointer",
                      position: "relative", marginBottom: 8, border: `1px solid ${t.border}`,
                      overflow: "hidden", display: "grid", placeItems: "center" }}>
                    <div style={{
                      position: "absolute", top: 0, left: 0, bottom: 0,
                      width: `${duration ? (curTime / duration) * 100 : 0}%`,
                      background: t.accentBg,
                    }} />
                    <span style={{ fontSize: 11.5, color: t.textDim, position: "relative" }}>
                      {peaks === "error" ? "Waveform unavailable" : "Analyzing waveform…"}
                    </span>
                  </div>
                )}
                <div style={{ display: "flex", justifyContent: "space-between",
                  fontSize: 12, color: t.textMuted, marginBottom: 18 }}>
                  <span>{fmtTime(curTime)}</span>
                  <span>{fmtTime(duration)}</span>
                </div>

                <div style={{ display: "flex", justifyContent: "center", alignItems: "center", gap: 14, marginBottom: 18 }}>
                  <button onClick={cycleLoop}
                    title={loopMode === "list" ? "Looping filtered tracks — click to repeat one"
                      : loopMode === "one" ? "Repeating this track — click to turn off"
                      : "Loop off — click to loop the list"}
                    style={{
                      width: 42, height: 42, borderRadius: "50%", cursor: "pointer",
                      background: loopMode !== "off" ? t.accentBg : t.bgCard2,
                      border: `1px solid ${loopMode !== "off" ? t.green : t.border}`,
                      color: loopMode !== "off" ? t.green : t.textMuted,
                      display: "grid", placeItems: "center",
                    }}>
                    <Icon d={loopMode === "one" ? ICONS.loopOne : ICONS.loop} size={17} />
                  </button>
                  <button onClick={togglePlay}
                    style={{
                      width: 60, height: 60, borderRadius: "50%", border: "none", cursor: "pointer",
                      background: `linear-gradient(135deg, ${t.green}, ${t.orange})`,
                      color: "#fff", display: "grid", placeItems: "center",
                    }}>
                    <Icon d={isPlaying ? ICONS.pause : ICONS.play} size={22}
                      fill={isPlaying ? "none" : "currentColor"} />
                  </button>
                  <button onClick={shuffle} title="Shuffle — play a random track"
                    style={{
                      width: 42, height: 42, borderRadius: "50%", cursor: "pointer",
                      background: t.bgCard2, border: `1px solid ${t.border}`,
                      color: t.textMuted, display: "grid", placeItems: "center",
                    }}>
                    <Icon d={ICONS.shuffle} size={17} />
                  </button>
                </div>

                <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 22 }}>
                  <span onClick={() => setVolume((v) => (v > 0 ? 0 : 1))}
                    title={volume > 0 ? "Mute" : "Unmute"}
                    style={{ color: t.textMuted, cursor: "pointer", display: "grid", placeItems: "center" }}>
                    <Icon d={volume === 0 ? ICONS.volumeMute : ICONS.volume} size={17} />
                  </span>
                  <input type="range" min={0} max={1} step={0.01} value={volume}
                    onChange={(e) => setVolume(parseFloat(e.target.value))}
                    className="vf-volume"
                    style={{
                      flex: 1, height: 6, cursor: "pointer",
                      accentColor: t.green,
                      background: "transparent",
                    }} />
                  <span style={{ fontSize: 12, color: t.textDim, minWidth: 32, textAlign: "right" }}>
                    {Math.round(volume * 100)}%
                  </span>
                </div>

                <div style={s.label}>Tags</div>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 7 }}>
                  {tags.map((tg) => {
                    const on = selected.tags.includes(tg.id);
                    return (
                      <span key={tg.id} onClick={() => toggleTrackTag(selected.id, tg.id)}
                        className="vf-chip" style={s.chip(on, tg.color)}>{tg.label}</span>
                    );
                  })}
                </div>

                <div style={{ marginTop: 18, display: "flex", gap: 8, flexWrap: "wrap" }}>
                  {!selected.assignedCover && (
                    <button onClick={() => { setBankTargetTrack(selected.id); setBankOpen(true); }}
                      style={{ display: "inline-flex", alignItems: "center", gap: 8,
                        padding: "8px 14px", borderRadius: 9, border: `1px solid ${t.border}`,
                        background: t.bgCard2, color: t.textMuted, cursor: "pointer", fontSize: 13,
                        fontWeight: 600, fontFamily: "inherit" }}>
                      <Icon d={ICONS.image} size={15} /> {selected.coverPath ? "Override cover" : "Set cover"}
                    </button>
                  )}
                  {selected.assignedCover && (
                    <>
                      <button onClick={() => { setBankTargetTrack(selected.id); setBankOpen(true); }}
                        style={{ display: "inline-flex", alignItems: "center", gap: 8,
                          padding: "8px 14px", borderRadius: 9, border: `1px solid ${t.border}`,
                          background: t.bgCard2, color: t.textMuted, cursor: "pointer", fontSize: 13,
                          fontWeight: 600, fontFamily: "inherit" }}>
                        <Icon d={ICONS.image} size={15} /> Change cover
                      </button>
                      <button onClick={() => assignCoverToOne(selected.id, null)}
                        style={{ display: "inline-flex", alignItems: "center", gap: 8,
                          padding: "8px 14px", borderRadius: 9, border: `1px solid ${t.border}`,
                          background: t.bgCard2, color: t.textMuted, cursor: "pointer", fontSize: 13,
                          fontWeight: 600, fontFamily: "inherit" }}>
                        <Icon d={ICONS.x} size={15} /> {selected.coverPath ? "Revert to original" : "Remove cover"}
                      </button>
                    </>
                  )}
                </div>
              </>
            ) : (
              <div style={{ flex: 1, display: "grid", placeItems: "center", textAlign: "center",
                color: t.textDim, fontSize: 13.5 }}>
                Click a track to preview it here.
              </div>
            )}
          </aside>
        </div>
      </div>

      {ctxMenu && (() => {
        const ctxTrack = tracks.find((x) => x.id === ctxMenu.trackId);
        const itemBase = { display: "flex", alignItems: "center", gap: 9, width: "100%",
          padding: "8px 10px", borderRadius: 7, border: "none", background: "transparent",
          cursor: "pointer", fontSize: 13, fontWeight: 600, fontFamily: "inherit",
          transition: "background 0.12s, color 0.12s", textAlign: "left" };
        return (
        <>
          <div onClick={() => setCtxMenu(null)} onContextMenu={(e) => { e.preventDefault(); setCtxMenu(null); }}
            style={{ position: "fixed", inset: 0, zIndex: 60 }} />
          <div style={{
            position: "fixed", left: Math.min(ctxMenu.x, window.innerWidth - 200),
            top: Math.min(ctxMenu.y, window.innerHeight - 300), zIndex: 61,
            background: t.bgCard, border: `1px solid ${t.border}`, borderRadius: 10,
            boxShadow: "0 10px 30px rgba(0,0,0,0.35)", padding: 5, minWidth: 180 }}>
            <button
              onClick={() => { toggleFavourite(ctxMenu.trackId); setCtxMenu(null); }}
              onMouseEnter={(e) => (e.currentTarget.style.background = t.bgHover)}
              onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
              style={{ ...itemBase, color: ctxTrack && ctxTrack.favourite ? "#eab308" : t.text }}>
              <Icon d={ICONS.star} size={15} fill={ctxTrack && ctxTrack.favourite ? "currentColor" : "none"} />
              {ctxTrack && ctxTrack.favourite ? "Unfavourite" : "Favourite"}
            </button>
            <button
              onClick={() => { setTrackUsed(ctxMenu.trackId, !(ctxTrack && isUsed(ctxTrack))); setCtxMenu(null); }}
              onMouseEnter={(e) => (e.currentTarget.style.background = t.bgHover)}
              onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
              style={{ ...itemBase, color: ctxTrack && isUsed(ctxTrack) ? t.green : t.text }}>
              <Icon d={ctxTrack && isUsed(ctxTrack) ? ICONS.undo : ICONS.check} size={15} />
              {ctxTrack && isUsed(ctxTrack) ? "Mark as unused" : "Mark as used"}
            </button>
            <button
              onClick={() => {
                const { title, artist } = parseName(ctxTrack);
                setRenaming({ trackId: ctxMenu.trackId, title: title || "", artist: artist || "" });
                setCtxMenu(null);
              }}
              onMouseEnter={(e) => (e.currentTarget.style.background = t.bgHover)}
              onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
              style={{ ...itemBase, color: t.text }}>
              <Icon d={ICONS.edit} size={15} /> Rename
            </button>
            <button
              onClick={() => { window.vf.reveal(ctxTrack.filePath); setCtxMenu(null); }}
              onMouseEnter={(e) => (e.currentTarget.style.background = t.bgHover)}
              onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
              style={{ ...itemBase, color: t.text }}>
              <Icon d={ICONS.reveal} size={15} /> Reveal in file explorer
            </button>
            <button
              onClick={() => { toggleNoCredit(ctxMenu.trackId); setCtxMenu(null); }}
              onMouseEnter={(e) => (e.currentTarget.style.background = t.bgHover)}
              onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
              style={{ ...itemBase, color: ctxTrack && ctxTrack.noCredit ? t.textDim : t.text }}>
              <Icon d={ICONS.clipboard} size={15} />
              {ctxTrack && ctxTrack.noCredit ? "Include in credits" : "Exclude from credits"}
            </button>
            <button
              onClick={() => { setPlaylistPicker({ trackIds: [ctxMenu.trackId] }); setCtxMenu(null); }}
              onMouseEnter={(e) => (e.currentTarget.style.background = t.bgHover)}
              onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
              style={{ ...itemBase, color: t.text }}>
              <Icon d={ICONS.playlist} size={15} /> Add to playlist…
            </button>
            {activePlaylist !== "all" && (
              <button
                onClick={() => { removeFromPlaylist(ctxMenu.trackId); setCtxMenu(null); }}
                onMouseEnter={(e) => (e.currentTarget.style.background = t.bgHover)}
                onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
                style={{ ...itemBase, color: t.text }}>
                <Icon d={ICONS.x} size={15} /> Remove from this playlist
              </button>
            )}
            <div style={{ height: 1, background: t.border, margin: "4px 6px" }} />
            <button
              onClick={() => { removeTrack(ctxMenu.trackId); setCtxMenu(null); }}
              onMouseEnter={(e) => { e.currentTarget.style.background = t.red; e.currentTarget.style.color = "#fff"; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; e.currentTarget.style.color = t.red; }}
              style={{ ...itemBase, color: t.red }}>
              <Icon d={ICONS.trash} size={15} /> Delete track
            </button>
          </div>
        </>
      ); })()}

      {tagsOpen && (
        <div onMouseDown={(e) => { if (e.target === e.currentTarget) setTagsOpen(false); }}
          className="vf-overlay" style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.55)",
            display: "grid", placeItems: "center", zIndex: 74 }}>
          <div className="vf-card" onClick={(e) => e.stopPropagation()}
            style={{ width: 400, maxWidth: "90vw", maxHeight: "78vh", background: t.bgCard,
              borderRadius: 14, border: `1px solid ${t.border}`, padding: 22,
              display: "flex", flexDirection: "column", boxShadow: "0 20px 60px rgba(0,0,0,0.4)" }}>
            <div style={{ display: "flex", alignItems: "center", marginBottom: 4 }}>
              <div style={{ fontSize: 16, fontWeight: 700, flex: 1 }}>Manage tags</div>
              <span onClick={() => setTagsOpen(false)}
                style={{ cursor: "pointer", color: t.textMuted, display: "grid", placeItems: "center", padding: 4 }}>
                <Icon d={ICONS.x} size={18} />
              </span>
            </div>
            <div style={{ fontSize: 12.5, color: t.textDim, marginBottom: 16 }}>
              Drag to reorder. Click a swatch to recolour.
            </div>
            <div className="vf-scroll" style={{ overflow: "auto", minHeight: 0, flex: 1,
              display: "flex", flexDirection: "column", gap: 5, marginBottom: 16 }}>
              {tags.length === 0 && (
                <div style={{ fontSize: 13, color: t.textDim, padding: "10px 0" }}>No tags yet.</div>
              )}
              {tags.map((tg, i) => (
                <div key={tg.id}
                  draggable
                  onDragStart={() => { dragTagIndex.current = i; }}
                  onDragOver={(e) => { e.preventDefault(); setDragOverTag(i); }}
                  onDragLeave={() => setDragOverTag((cur) => (cur === i ? null : cur))}
                  onDrop={(e) => { e.preventDefault(); reorderTags(dragTagIndex.current, i); dragTagIndex.current = null; setDragOverTag(null); }}
                  onDragEnd={() => { dragTagIndex.current = null; setDragOverTag(null); }}
                  style={{ display: "flex", alignItems: "center", gap: 9, fontSize: 13,
                    padding: "8px 10px", borderRadius: 9, background: t.bgCard2,
                    border: `1px solid ${t.border}`,
                    borderTop: `2px solid ${dragOverTag === i && dragTagIndex.current !== null ? t.green : t.border}` }}>
                  <span style={{ cursor: "grab", color: t.textDim, display: "grid", placeItems: "center", flexShrink: 0 }}
                    title="Drag to reorder">
                    <Icon d={ICONS.grip} size={14} />
                  </span>
                  <input type="color" className="vf-swatch" value={tg.color}
                    title="Change colour"
                    onChange={(e) => setTagColor(tg.id, e.target.value)}
                    style={{ width: 18, height: 18, flexShrink: 0, borderRadius: 5 }} />
                  <span style={{ flex: 1, color: t.text, whiteSpace: "nowrap",
                    overflow: "hidden", textOverflow: "ellipsis" }}>{tg.label}</span>
                  <span style={{ fontSize: 12, color: t.textDim }}>
                    {tracks.filter((tr) => (tr.tags || []).includes(tg.id)).length}
                  </span>
                  <span onClick={() => removeTag(tg.id)} title="Delete tag"
                    onMouseEnter={(e) => (e.currentTarget.style.color = t.red)}
                    onMouseLeave={(e) => (e.currentTarget.style.color = t.textDim)}
                    style={{ cursor: "pointer", color: t.textDim, display: "grid", placeItems: "center", flexShrink: 0 }}>
                    <Icon d={ICONS.trash} size={14} />
                  </span>
                </div>
              ))}
            </div>
            <button onClick={openAddTag}
              style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 7,
                width: "100%", padding: "9px 10px", borderRadius: 9,
                border: `1px dashed ${t.border}`, background: "transparent", color: t.green,
                cursor: "pointer", fontSize: 13, fontWeight: 600, fontFamily: "inherit" }}>
              <Icon d={ICONS.plus} size={15} /> Add tag
            </button>
          </div>
        </div>
      )}

      {creditsOpen && (
        <div onMouseDown={(e) => { if (e.target === e.currentTarget) setCreditsOpen(false); }}
          className="vf-overlay" style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.55)",
            display: "grid", placeItems: "center", zIndex: 76 }}>
          <div className="vf-card" onClick={(e) => e.stopPropagation()}
            style={{ width: 440, maxWidth: "92vw", maxHeight: "80vh", background: t.bgCard,
              borderRadius: 14, border: `1px solid ${t.border}`, padding: 22,
              display: "flex", flexDirection: "column", boxShadow: "0 20px 60px rgba(0,0,0,0.4)" }}>
            <div style={{ display: "flex", alignItems: "center", marginBottom: 4 }}>
              <div style={{ fontSize: 16, fontWeight: 700, flex: 1 }}>Credits</div>
              <span onClick={() => setCreditsOpen(false)}
                style={{ cursor: "pointer", color: t.textMuted, display: "grid", placeItems: "center", padding: 4 }}>
                <Icon d={ICONS.x} size={18} />
              </span>
            </div>
            <div style={{ fontSize: 12.5, color: t.textDim, marginBottom: 16 }}>
              {creditCount} of {usedCount} used track{usedCount !== 1 ? "s" : ""} in{" "}
              “{(profiles.find((p) => p.id === activeProfile) || {}).name}”, in order of use.
              Drag to rearrange before copying.
            </div>
            <div className="vf-scroll" style={{ overflow: "auto", minHeight: 0, flex: 1,
              display: "flex", flexDirection: "column", gap: 5, marginBottom: 16 }}>
              {creditTracks.map((tr, i) => {
                const { title, artist } = parseName(tr);
                return (
                  <div key={tr.id}
                    draggable
                    onDragStart={() => { dragCreditIndex.current = i; }}
                    onDragOver={(e) => { e.preventDefault(); setDragOverCredit(i); }}
                    onDragLeave={() => setDragOverCredit((cur) => (cur === i ? null : cur))}
                    onDrop={(e) => {
                      e.preventDefault();
                      const from = dragCreditIndex.current;
                      if (from != null && from !== i) {
                        const ids = creditTracks.map((x) => x.id);
                        const [moved] = ids.splice(from, 1);
                        ids.splice(i, 0, moved);
                        saveCreditOrder(ids);
                      }
                      dragCreditIndex.current = null; setDragOverCredit(null);
                    }}
                    onDragEnd={() => { dragCreditIndex.current = null; setDragOverCredit(null); }}
                    style={{ display: "flex", alignItems: "center", gap: 9, fontSize: 13,
                      padding: "8px 10px", borderRadius: 9, background: t.bgCard2,
                      border: `1px solid ${t.border}`,
                      borderTop: `2px solid ${dragOverCredit === i && dragCreditIndex.current !== null ? t.green : t.border}` }}>
                    <span style={{ cursor: "grab", color: t.textDim, display: "grid", placeItems: "center", flexShrink: 0 }}
                      title="Drag to reorder">
                      <Icon d={ICONS.grip} size={14} />
                    </span>
                    <span style={{ width: 20, flexShrink: 0, color: t.textDim, fontSize: 12 }}>{i + 1}</span>
                    <span style={{ flex: 1, minWidth: 0, whiteSpace: "nowrap", overflow: "hidden",
                      textOverflow: "ellipsis", color: t.text }}>
                      {artist ? `${artist} — ${title}` : title}
                    </span>
                    <span onClick={() => toggleNoCredit(tr.id)} title="Exclude from credits"
                      onMouseEnter={(e) => (e.currentTarget.style.color = t.red)}
                      onMouseLeave={(e) => (e.currentTarget.style.color = t.textDim)}
                      style={{ cursor: "pointer", color: t.textDim, display: "grid", placeItems: "center", flexShrink: 0 }}>
                      <Icon d={ICONS.x} size={14} />
                    </span>
                  </div>
                );
              })}
            </div>
            <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
              <button onClick={() => saveCreditOrder([])}
                style={{ padding: "9px 14px", borderRadius: 9, border: `1px solid ${t.border}`,
                  background: t.bgCard2, color: t.textMuted, cursor: "pointer", fontSize: 13,
                  fontWeight: 600, fontFamily: "inherit" }}>
                Reset to use order
              </button>
              <button onClick={copyCredits}
                style={{ display: "inline-flex", alignItems: "center", gap: 8, padding: "9px 16px",
                  borderRadius: 9, border: "none", background: t.green, color: "#fff",
                  cursor: "pointer", fontSize: 13, fontWeight: 600, fontFamily: "inherit" }}>
                <Icon d={creditsCopied ? ICONS.check : ICONS.clipboard} size={15} />
                {creditsCopied ? "Copied!" : "Copy credits"}
              </button>
            </div>
          </div>
        </div>
      )}

      {projectPrompt && (
        <div className="vf-overlay" style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)",
          display: "grid", placeItems: "center", zIndex: 90 }}>
          <div className="vf-card"
            style={{ width: 400, maxWidth: "92vw", maxHeight: "72vh", background: t.bgCard,
              borderRadius: 16, border: `1px solid ${t.border}`, padding: 24,
              display: "flex", flexDirection: "column", boxShadow: "0 20px 60px rgba(0,0,0,0.45)" }}>
            <div style={{ fontSize: 17, fontWeight: 700, marginBottom: 4 }}>Which video are you working on?</div>
            <div style={{ fontSize: 12.5, color: t.textDim, marginBottom: 18 }}>
              Pick a project to continue — tracks you drag out will be marked as used in it.
            </div>
            <div className="vf-scroll" style={{ overflow: "auto", minHeight: 0, flex: 1,
              display: "flex", flexDirection: "column", gap: 6, marginBottom: 18 }}>
              {profiles.map((pf) => {
                const on = pf.id === activeProfile;
                return (
                  <button key={pf.id}
                    onClick={() => { setActiveProfile(pf.id); setProjectPrompt(false); }}
                    style={{ display: "flex", alignItems: "center", gap: 10, width: "100%",
                      padding: "11px 13px", borderRadius: 10, cursor: "pointer",
                      fontSize: 13.5, fontWeight: 600, fontFamily: "inherit", textAlign: "left",
                      background: on ? t.accentBg : t.bgCard2,
                      border: `1px solid ${on ? t.green : t.border}`,
                      color: on ? t.green : t.text }}>
                    <Icon d={ICONS.film} size={15} />
                    <span style={{ flex: 1, whiteSpace: "nowrap", overflow: "hidden",
                      textOverflow: "ellipsis" }}>{pf.name}</span>
                    <span style={{ fontSize: 12, color: t.textDim }}>
                      {tracks.filter((tr) => tr.usedBy && tr.usedBy[pf.id]).length} used
                    </span>
                  </button>
                );
              })}
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              <button onClick={() => { setProjectPrompt(false); setNewItem({ kind: "profile", name: "" }); }}
                style={{ flex: 1, display: "inline-flex", alignItems: "center", justifyContent: "center",
                  gap: 7, padding: "9px 14px",
                  borderRadius: 9, border: `1px solid ${t.border}`, background: t.bgCard2,
                  color: t.green, cursor: "pointer", fontSize: 13, fontWeight: 600, fontFamily: "inherit" }}>
                <Icon d={ICONS.plus} size={14} /> New project
              </button>
            </div>
            <div onClick={() => { setSettings((p) => ({ ...p, askProjectOnOpen: false })); setProjectPrompt(false); }}
              style={{ marginTop: 14, fontSize: 12, color: t.textDim, cursor: "pointer", textAlign: "center" }}>
              Don't ask me on startup
            </div>
          </div>
        </div>
      )}

      {renameItem && (
        <div onMouseDown={(e) => { if (e.target === e.currentTarget) setRenameItem(null); }}
          className="vf-overlay" style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.55)",
            display: "grid", placeItems: "center", zIndex: 74 }}>
          <div className="vf-card" onClick={(e) => e.stopPropagation()}
            style={{ width: 360, maxWidth: "90vw", background: t.bgCard, borderRadius: 14,
              border: `1px solid ${t.border}`, padding: 22, boxShadow: "0 20px 60px rgba(0,0,0,0.4)" }}>
            <div style={{ fontSize: 16, fontWeight: 700, marginBottom: 16 }}>
              Rename {renameItem.kind === "playlist" ? "playlist" : "project"}
            </div>
            <input autoFocus value={renameItem.name}
              onChange={(e) => setRenameItem((r) => ({ ...r, name: e.target.value }))}
              onKeyDown={(e) => {
                if (e.key === "Enter" && renameItem.name.trim()) {
                  if (renameItem.kind === "playlist") renamePlaylist(renameItem.id, renameItem.name.trim());
                  else renameProfile(renameItem.id, renameItem.name.trim());
                  setRenameItem(null);
                }
                if (e.key === "Escape") setRenameItem(null);
              }}
              style={{ width: "100%", boxSizing: "border-box", padding: "9px 11px", marginBottom: 20,
                background: t.bgCard2, border: `1px solid ${t.border}`, borderRadius: 8,
                color: t.text, fontSize: 14, fontFamily: "inherit", outline: "none" }} />
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
              <button onClick={() => setRenameItem(null)}
                style={{ padding: "8px 16px", borderRadius: 8, border: `1px solid ${t.border}`,
                  background: t.bgCard2, color: t.textMuted, cursor: "pointer", fontSize: 13,
                  fontWeight: 600, fontFamily: "inherit" }}>
                Cancel
              </button>
              <button disabled={!renameItem.name.trim()}
                onClick={() => {
                  if (renameItem.kind === "playlist") renamePlaylist(renameItem.id, renameItem.name.trim());
                  else renameProfile(renameItem.id, renameItem.name.trim());
                  setRenameItem(null);
                }}
                style={{ padding: "8px 16px", borderRadius: 8, border: "none",
                  background: renameItem.name.trim() ? t.green : t.bgCard2,
                  color: renameItem.name.trim() ? "#fff" : t.textDim,
                  cursor: renameItem.name.trim() ? "pointer" : "not-allowed",
                  fontSize: 13, fontWeight: 600, fontFamily: "inherit" }}>
                Save
              </button>
            </div>
          </div>
        </div>
      )}

      {playlistPicker && (() => {
        const ids = playlistPicker.trackIds;
        return (
        <div onMouseDown={(e) => { if (e.target === e.currentTarget) setPlaylistPicker(null); }}
          className="vf-overlay" style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.55)",
            display: "grid", placeItems: "center", zIndex: 72 }}>
          <div className="vf-card" onClick={(e) => e.stopPropagation()}
            style={{ width: 380, maxWidth: "90vw", maxHeight: "70vh", background: t.bgCard,
              borderRadius: 14, border: `1px solid ${t.border}`, padding: 22,
              display: "flex", flexDirection: "column", boxShadow: "0 20px 60px rgba(0,0,0,0.4)" }}>
            <div style={{ fontSize: 16, fontWeight: 700, marginBottom: 4 }}>Add to playlist</div>
            <div style={{ fontSize: 12.5, color: t.textDim, marginBottom: 16 }}>
              {ids.length === 1 ? "Tick the playlists this track belongs to."
                : `Tick a playlist to add all ${ids.length} selected tracks.`}
            </div>

            <div className="vf-scroll" style={{ overflow: "auto", minHeight: 0, flex: 1,
              display: "flex", flexDirection: "column", gap: 5, marginBottom: 16 }}>
              {playlists.length === 0 && (
                <div style={{ fontSize: 13, color: t.textDim, padding: "10px 0" }}>
                  No playlists yet — create one below.
                </div>
              )}
              {playlists.map((pl) => {
                const on = allInPlaylist(ids, pl.id);
                return (
                  <button key={pl.id}
                    onClick={() => setPlaylistMembership(ids, pl.id, !on)}
                    onMouseEnter={(e) => (e.currentTarget.style.background = t.bgHover)}
                    onMouseLeave={(e) => (e.currentTarget.style.background = on ? t.accentBg : "transparent")}
                    style={{ display: "flex", alignItems: "center", gap: 10, width: "100%",
                      padding: "9px 11px", borderRadius: 9, cursor: "pointer",
                      fontSize: 13, fontWeight: 600, fontFamily: "inherit", textAlign: "left",
                      background: on ? t.accentBg : "transparent",
                      border: `1px solid ${on ? t.green : t.border}`,
                      color: on ? t.green : t.text }}>
                    <span style={{ width: 18, height: 18, borderRadius: 5, flexShrink: 0,
                      display: "grid", placeItems: "center",
                      background: on ? t.green : "transparent",
                      border: `1px solid ${on ? t.green : t.border}`, color: "#fff" }}>
                      {on && <Icon d={ICONS.check} size={12} />}
                    </span>
                    <span style={{ flex: 1, whiteSpace: "nowrap", overflow: "hidden",
                      textOverflow: "ellipsis" }}>{pl.name}</span>
                    <span style={{ fontSize: 12, color: t.textDim }}>
                      {tracks.filter((tr) => (tr.playlists || []).includes(pl.id)).length}
                    </span>
                  </button>
                );
              })}
            </div>

            <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
              <button onClick={() => setNewItem({ kind: "playlist", name: "", assignTo: ids })}
                style={{ display: "inline-flex", alignItems: "center", gap: 7, padding: "8px 14px",
                  borderRadius: 8, border: `1px solid ${t.border}`, background: t.bgCard2,
                  color: t.green, cursor: "pointer", fontSize: 13, fontWeight: 600, fontFamily: "inherit" }}>
                <Icon d={ICONS.plus} size={14} /> New playlist
              </button>
              <button onClick={() => setPlaylistPicker(null)}
                style={{ padding: "8px 16px", borderRadius: 8, border: "none",
                  background: t.green, color: "#fff", cursor: "pointer", fontSize: 13,
                  fontWeight: 600, fontFamily: "inherit" }}>
                Done
              </button>
            </div>
          </div>
        </div>
        );
      })()}

      {newItem && (
        <div onMouseDown={(e) => { if (e.target === e.currentTarget) setNewItem(null); }}
          className="vf-overlay" style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.55)",
            display: "grid", placeItems: "center", zIndex: 96 }}>
          <div className="vf-card" onClick={(e) => e.stopPropagation()}
            style={{ width: 360, maxWidth: "90vw", background: t.bgCard, borderRadius: 14,
              border: `1px solid ${t.border}`, padding: 22, boxShadow: "0 20px 60px rgba(0,0,0,0.4)" }}>
            <div style={{ fontSize: 16, fontWeight: 700, marginBottom: 4 }}>
              {newItem.kind === "playlist" ? "New playlist" : "New video project"}
            </div>
            <div style={{ fontSize: 12.5, color: t.textDim, marginBottom: 16 }}>
              {newItem.kind === "playlist"
                ? "Tracks you import while this playlist is open will be added to it."
                : "Used tracks are remembered separately for each video project."}
            </div>
            <input autoFocus value={newItem.name}
              onChange={(e) => setNewItem((n) => ({ ...n, name: e.target.value }))}
              onKeyDown={(e) => { if (e.key === "Enter") createNewItem(); if (e.key === "Escape") setNewItem(null); }}
              placeholder={newItem.kind === "playlist" ? "Playlist name…" : "Project name…"}
              style={{ width: "100%", boxSizing: "border-box", padding: "9px 11px", marginBottom: 20,
                background: t.bgCard2, border: `1px solid ${t.border}`, borderRadius: 8,
                color: t.text, fontSize: 14, fontFamily: "inherit", outline: "none" }} />
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
              <button onClick={() => setNewItem(null)}
                style={{ padding: "8px 16px", borderRadius: 8, border: `1px solid ${t.border}`,
                  background: t.bgCard2, color: t.textMuted, cursor: "pointer", fontSize: 13,
                  fontWeight: 600, fontFamily: "inherit" }}>
                Cancel
              </button>
              <button onClick={createNewItem} disabled={!newItem.name.trim()}
                style={{ padding: "8px 16px", borderRadius: 8, border: "none",
                  background: newItem.name.trim() ? t.green : t.bgCard2,
                  color: newItem.name.trim() ? "#fff" : t.textDim,
                  cursor: newItem.name.trim() ? "pointer" : "not-allowed", fontSize: 13,
                  fontWeight: 600, fontFamily: "inherit" }}>
                Create
              </button>
            </div>
          </div>
        </div>
      )}

      {addTagOpen && (
        <div onMouseDown={(e) => { if (e.target === e.currentTarget) setAddTagOpen(false); }}
          className="vf-overlay" style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.55)",
            display: "grid", placeItems: "center", zIndex: 94 }}>
          <div className="vf-card" onClick={(e) => e.stopPropagation()}
            style={{ width: 340, maxWidth: "90vw", background: t.bgCard, borderRadius: 14,
              border: `1px solid ${t.border}`, padding: 22, boxShadow: "0 20px 60px rgba(0,0,0,0.4)" }}>
            <div style={{ fontSize: 16, fontWeight: 700, marginBottom: 16 }}>New tag</div>
            <div style={{ display: "flex", gap: 10, alignItems: "center", marginBottom: 18 }}>
              <input type="color" className="vf-swatch" value={newTagColor}
                title="Tag colour"
                onChange={(e) => setNewTagColor(e.target.value)}
                style={{ width: 38, height: 38, flexShrink: 0, borderRadius: 8 }} />
              <input autoFocus value={newTag}
                onChange={(e) => setNewTag(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") addTag(); if (e.key === "Escape") setAddTagOpen(false); }}
                placeholder="Tag name…"
                style={{ flex: 1, boxSizing: "border-box", padding: "9px 11px",
                  background: t.bgCard2, border: `1px solid ${t.border}`, borderRadius: 8,
                  color: t.text, fontSize: 14, fontFamily: "inherit", outline: "none" }} />
            </div>
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
              <button onClick={() => setAddTagOpen(false)}
                style={{ padding: "8px 16px", borderRadius: 8, border: `1px solid ${t.border}`,
                  background: t.bgCard2, color: t.textMuted, cursor: "pointer", fontSize: 13,
                  fontWeight: 600, fontFamily: "inherit" }}>
                Cancel
              </button>
              <button onClick={addTag} disabled={!newTag.trim()}
                style={{ padding: "8px 16px", borderRadius: 8, border: "none",
                  background: newTag.trim() ? t.green : t.bgCard2,
                  color: newTag.trim() ? "#fff" : t.textDim,
                  cursor: newTag.trim() ? "pointer" : "not-allowed", fontSize: 13,
                  fontWeight: 600, fontFamily: "inherit" }}>
                Add tag
              </button>
            </div>
          </div>
        </div>
      )}

      {renaming && (
        <div onMouseDown={(e) => { if (e.target === e.currentTarget) setRenaming(null); }}
          className="vf-overlay" style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.55)",
            display: "grid", placeItems: "center", zIndex: 78 }}>
          <div className="vf-card" onClick={(e) => e.stopPropagation()}
            style={{ width: 380, maxWidth: "90vw", background: t.bgCard, borderRadius: 14,
              border: `1px solid ${t.border}`, padding: 22, boxShadow: "0 20px 60px rgba(0,0,0,0.4)" }}>
            <div style={{ fontSize: 16, fontWeight: 700, marginBottom: 4 }}>Rename track</div>
            <div style={{ fontSize: 12.5, color: t.textDim, marginBottom: 16 }}>
              Leave a field empty to restore its original value.
            </div>
            <div style={{ fontSize: 12, fontWeight: 600, color: t.textMuted, marginBottom: 6 }}>Title</div>
            <input autoFocus value={renaming.title}
              onChange={(e) => setRenaming((r) => ({ ...r, title: e.target.value }))}
              onKeyDown={(e) => { if (e.key === "Enter") saveRename(); if (e.key === "Escape") setRenaming(null); }}
              style={{ width: "100%", boxSizing: "border-box", padding: "9px 11px", marginBottom: 14,
                background: t.bgCard2, border: `1px solid ${t.border}`, borderRadius: 8,
                color: t.text, fontSize: 14, fontFamily: "inherit", outline: "none" }} />
            <div style={{ fontSize: 12, fontWeight: 600, color: t.textMuted, marginBottom: 6 }}>Artist / Game</div>
            <input value={renaming.artist}
              onChange={(e) => setRenaming((r) => ({ ...r, artist: e.target.value }))}
              onKeyDown={(e) => { if (e.key === "Enter") saveRename(); if (e.key === "Escape") setRenaming(null); }}
              style={{ width: "100%", boxSizing: "border-box", padding: "9px 11px", marginBottom: 20,
                background: t.bgCard2, border: `1px solid ${t.border}`, borderRadius: 8,
                color: t.text, fontSize: 14, fontFamily: "inherit", outline: "none" }} />
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
              <button onClick={() => setRenaming(null)}
                style={{ padding: "8px 16px", borderRadius: 8, border: `1px solid ${t.border}`,
                  background: t.bgCard2, color: t.textMuted, cursor: "pointer", fontSize: 13,
                  fontWeight: 600, fontFamily: "inherit" }}>
                Cancel
              </button>
              <button onClick={saveRename}
                style={{ padding: "8px 16px", borderRadius: 8, border: "none",
                  background: t.green, color: "#fff", cursor: "pointer", fontSize: 13,
                  fontWeight: 600, fontFamily: "inherit" }}>
                Save
              </button>
            </div>
          </div>
        </div>
      )}

      {settingsOpen && (
        <div onMouseDown={(e) => { if (e.target === e.currentTarget) setSettingsOpen(false); }}
          className="vf-overlay" style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.55)",
            display: "grid", placeItems: "center", zIndex: 70 }}>
          <div className="vf-card" onClick={(e) => e.stopPropagation()}
            style={{ width: 460, maxWidth: "92vw", maxHeight: "85vh", background: t.bgCard,
              borderRadius: 16, border: `1px solid ${t.border}`, display: "flex", flexDirection: "column",
              overflow: "hidden", boxShadow: "0 20px 60px rgba(0,0,0,0.4)" }}>
            <div style={{ padding: "18px 22px", borderBottom: `1px solid ${t.border}`,
              display: "flex", alignItems: "center" }}>
              <div style={{ fontSize: 16, fontWeight: 700, flex: 1 }}>Settings</div>
              <span onClick={() => setSettingsOpen(false)}
                style={{ cursor: "pointer", color: t.textMuted, display: "grid", placeItems: "center", padding: 4 }}>
                <Icon d={ICONS.x} size={18} />
              </span>
            </div>

            <div className="vf-scroll" style={{ padding: 22, overflow: "auto" }}>
              {/* Appearance */}
              <div style={s.label}>Appearance</div>
              <div style={{ display: "flex", gap: 8, marginBottom: 18 }}>
                <button onClick={() => setSettings((p) => ({ ...p, lightMode: false }))}
                  style={{ flex: 1, display: "inline-flex", alignItems: "center", justifyContent: "center",
                    gap: 8, padding: "10px", borderRadius: 10, cursor: "pointer", fontFamily: "inherit",
                    fontSize: 13, fontWeight: 600,
                    border: `1px solid ${!isLight ? t.green : t.border}`,
                    background: !isLight ? t.accentBg : t.bgCard2,
                    color: !isLight ? t.green : t.textMuted }}>
                  <Icon d={ICONS.moon} size={15} /> Dark
                </button>
                <button onClick={() => setSettings((p) => ({ ...p, lightMode: true }))}
                  style={{ flex: 1, display: "inline-flex", alignItems: "center", justifyContent: "center",
                    gap: 8, padding: "10px", borderRadius: 10, cursor: "pointer", fontFamily: "inherit",
                    fontSize: 13, fontWeight: 600,
                    border: `1px solid ${isLight ? t.green : t.border}`,
                    background: isLight ? t.accentBg : t.bgCard2,
                    color: isLight ? t.green : t.textMuted }}>
                  <Icon d={ICONS.sun} size={15} /> Light
                </button>
              </div>

              {/* Filename format */}
              <div style={s.label}>Filename format</div>
              <div style={{ display: "flex", gap: 8, marginBottom: 22 }}>
                <button onClick={() => setSettings((p) => ({ ...p, nameLast: false }))}
                  style={{ flex: 1, padding: "10px", borderRadius: 10, cursor: "pointer", fontFamily: "inherit",
                    fontSize: 12.5, fontWeight: 600,
                    border: `1px solid ${!nameLast ? t.green : t.border}`,
                    background: !nameLast ? t.accentBg : t.bgCard2,
                    color: !nameLast ? t.green : t.textMuted }}>
                  Artist - Name
                </button>
                <button onClick={() => setSettings((p) => ({ ...p, nameLast: true }))}
                  style={{ flex: 1, padding: "10px", borderRadius: 10, cursor: "pointer", fontFamily: "inherit",
                    fontSize: 12.5, fontWeight: 600,
                    border: `1px solid ${nameLast ? t.green : t.border}`,
                    background: nameLast ? t.accentBg : t.bgCard2,
                    color: nameLast ? t.green : t.textMuted }}>
                  Name - Artist
                </button>
              </div>

              {/* Accent theme */}
              <div style={s.label}>Accent theme</div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 22 }}>
                {Object.entries(ACCENTS).map(([name, pair]) => {
                  const [c1, c2] = isLight ? pair.light : pair.dark;
                  const active = accentName === name;
                  return (
                    <button key={name} onClick={() => setSettings((p) => ({ ...p, accent: name }))}
                      title={name}
                      style={{ display: "inline-flex", alignItems: "center", gap: 8, padding: "7px 11px",
                        borderRadius: 999, cursor: "pointer", fontFamily: "inherit", fontSize: 12.5, fontWeight: 600,
                        border: `1px solid ${active ? t.green : t.border}`,
                        background: active ? t.accentBg : t.bgCard2,
                        color: active ? t.text : t.textMuted }}>
                      <span style={{ width: 16, height: 16, borderRadius: "50%",
                        background: `linear-gradient(135deg, ${c1}, ${c2})`, flexShrink: 0 }} />
                      {name}
                    </button>
                  );
                })}
              </div>

              {/* Library stats */}
              <div style={s.label}>Your library</div>
              <div style={{ display: "flex", gap: 10, marginBottom: 18 }}>
                <div style={{ flex: 1, padding: 14, borderRadius: 12, background: t.bgCard2,
                  border: `1px solid ${t.border}`, textAlign: "center" }}>
                  <div style={{ fontSize: 24, fontWeight: 700, color: t.green }}>{tracks.length}</div>
                  <div style={{ fontSize: 12, color: t.textDim }}>tracks</div>
                </div>
                <div style={{ flex: 1, padding: 14, borderRadius: 12, background: t.bgCard2,
                  border: `1px solid ${t.border}`, textAlign: "center" }}>
                  <div style={{ fontSize: 24, fontWeight: 700, color: t.orange }}>{totalMinutes}</div>
                  <div style={{ fontSize: 12, color: t.textDim }}>minutes</div>
                </div>
                <div style={{ flex: 1, padding: 14, borderRadius: 12, background: t.bgCard2,
                  border: `1px solid ${t.border}`, textAlign: "center" }}>
                  <div style={{ fontSize: 24, fontWeight: 700, color: t.text }}>{artistCounts.length}</div>
                  <div style={{ fontSize: 12, color: t.textDim }}>artists</div>
                </div>
              </div>

              {/* Manage playlists */}
              <div style={s.label}>Playlists</div>
              <div style={{ display: "flex", flexDirection: "column", gap: 5, marginBottom: 18 }}>
                {playlists.length === 0 && (
                  <div style={{ fontSize: 12.5, color: t.textDim }}>No playlists yet.</div>
                )}
                {playlists.map((pl) => (
                  <div key={pl.id} style={{ display: "flex", alignItems: "center", gap: 8,
                    fontSize: 13, padding: "6px 9px", borderRadius: 8, background: t.bgCard2,
                    border: `1px solid ${pl.id === activePlaylist ? t.green : t.border}` }}>
                    <Icon d={ICONS.playlist} size={14} />
                    <span style={{ flex: 1, whiteSpace: "nowrap", overflow: "hidden",
                      textOverflow: "ellipsis", color: t.text }}>{pl.name}</span>
                    <span style={{ fontSize: 12, color: t.textDim }}>
                      {tracks.filter((tr) => (tr.playlists || []).includes(pl.id)).length}
                    </span>
                    <span onClick={() => setRenameItem({ kind: "playlist", id: pl.id, name: pl.name })}
                      title="Rename"
                      style={{ cursor: "pointer", color: t.textDim, display: "grid", placeItems: "center" }}>
                      <Icon d={ICONS.edit} size={14} />
                    </span>
                    <span onClick={() => deletePlaylist(pl.id)} title="Delete playlist"
                      style={{ cursor: "pointer", color: t.textDim, display: "grid", placeItems: "center" }}>
                      <Icon d={ICONS.trash} size={14} />
                    </span>
                  </div>
                ))}
                <button onClick={() => setNewItem({ kind: "playlist", name: "" })}
                  style={{ marginTop: 3, display: "flex", alignItems: "center", justifyContent: "center",
                    gap: 7, padding: "7px 10px", borderRadius: 8, border: `1px dashed ${t.border}`,
                    background: "transparent", color: t.textMuted, cursor: "pointer",
                    fontSize: 12.5, fontWeight: 600, fontFamily: "inherit" }}>
                  <Icon d={ICONS.plus} size={14} /> New playlist
                </button>
              </div>

              {/* Manage video projects */}
              <div style={s.label}>Video projects</div>
              <div style={{ display: "flex", flexDirection: "column", gap: 5, marginBottom: 18 }}>
                {profiles.map((pf) => (
                  <div key={pf.id} style={{ display: "flex", alignItems: "center", gap: 8,
                    fontSize: 13, padding: "6px 9px", borderRadius: 8, background: t.bgCard2,
                    border: `1px solid ${pf.id === activeProfile ? t.green : t.border}` }}>
                    <Icon d={ICONS.film} size={14} />
                    <span style={{ flex: 1, whiteSpace: "nowrap", overflow: "hidden",
                      textOverflow: "ellipsis", color: t.text }}>{pf.name}</span>
                    <span style={{ fontSize: 12, color: t.textDim }}>
                      {tracks.filter((tr) => tr.usedBy && tr.usedBy[pf.id]).length}
                    </span>
                    <span onClick={() => setRenameItem({ kind: "profile", id: pf.id, name: pf.name })}
                      title="Rename"
                      style={{ cursor: "pointer", color: t.textDim, display: "grid", placeItems: "center" }}>
                      <Icon d={ICONS.edit} size={14} />
                    </span>
                    <span onClick={() => profiles.length > 1 && deleteProfile(pf.id)}
                      title={profiles.length > 1 ? "Delete project" : "Keep at least one project"}
                      style={{ cursor: profiles.length > 1 ? "pointer" : "not-allowed",
                        color: profiles.length > 1 ? t.textDim : t.border,
                        display: "grid", placeItems: "center" }}>
                      <Icon d={ICONS.trash} size={14} />
                    </span>
                  </div>
                ))}
                <button onClick={() => setNewItem({ kind: "profile", name: "" })}
                  style={{ marginTop: 3, display: "flex", alignItems: "center", justifyContent: "center",
                    gap: 7, padding: "7px 10px", borderRadius: 8, border: `1px dashed ${t.border}`,
                    background: "transparent", color: t.textMuted, cursor: "pointer",
                    fontSize: 12.5, fontWeight: 600, fontFamily: "inherit" }}>
                  <Icon d={ICONS.plus} size={14} /> New project
                </button>
              </div>

              {/* Ask for project on startup */}
              <div style={s.label}>On startup</div>
              <div style={{ marginBottom: 22 }}>
                <span onClick={() => setSettings((p) => ({ ...p, askProjectOnOpen: !(p.askProjectOnOpen !== false) }))}
                  className="vf-chip"
                  style={{ ...s.chip(askProjectOnOpen, t.green), padding: "6px 11px", gap: 7 }}>
                  <Icon d={ICONS.film} size={13} /> Ask which project on open
                </span>
              </div>

              {/* Per-artist breakdown */}
              {artistCounts.length > 0 && (
                <>
                  <div style={{ ...s.label, marginBottom: 8 }}>Tracks by artist / game</div>
                  <div className="vf-scroll"
                    style={{ display: "flex", gap: 18, overflow: "auto", minHeight: 0, flex: 1,
                      alignItems: "flex-start" }}>
                    {/* Pie */}
                    <svg viewBox="0 0 200 200" width={180} height={180} style={{ flexShrink: 0 }}>
                      {(() => {
                        const total = tracks.length;
                        // A single artist (one full-circle slice) can't be drawn as an arc,
                        // so render it as a plain circle.
                        if (artistCounts.length === 1) {
                          return (
                            <circle cx={100} cy={100} r={92}
                              fill={SLICE_COLORS[0]} stroke={t.bgCard} strokeWidth={2}
                              style={{ cursor: "pointer" }}
                              onMouseEnter={() => setHoverSlice(0)}
                              onMouseLeave={() => setHoverSlice(null)} />
                          );
                        }
                        let angle = -Math.PI / 2; // start at top
                        return artistCounts.map(([name, count], i) => {
                          const slice = (count / total) * Math.PI * 2;
                          const start = angle;
                          const end = angle + slice;
                          angle = end;
                          const hovered = hoverSlice === i;
                          // nudge hovered slice outward slightly
                          const mid = (start + end) / 2;
                          const offset = hovered ? 6 : 0;
                          const cx = 100 + offset * Math.cos(mid);
                          const cy = 100 + offset * Math.sin(mid);
                          return (
                            <path key={name}
                              d={arcPath(cx, cy, 92, start, end)}
                              fill={SLICE_COLORS[i % SLICE_COLORS.length]}
                              stroke={t.bgCard} strokeWidth={2}
                              style={{ cursor: "pointer", transition: "transform 0.1s" }}
                              onMouseEnter={() => setHoverSlice(i)}
                              onMouseLeave={() => setHoverSlice(null)} />
                          );
                        });
                      })()}
                    </svg>

                    {/* Hover detail + legend */}
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ minHeight: 44, marginBottom: 10 }}>
                        {hoverSlice !== null && artistCounts[hoverSlice] ? (
                          <>
                            <div style={{ fontSize: 14, fontWeight: 700, whiteSpace: "nowrap",
                              overflow: "hidden", textOverflow: "ellipsis" }}>
                              {artistCounts[hoverSlice][0]}
                            </div>
                            <div style={{ fontSize: 12.5, color: t.textDim }}>
                              {artistCounts[hoverSlice][1]} track{artistCounts[hoverSlice][1] !== 1 ? "s" : ""}
                              {" · "}
                              {Math.round((artistCounts[hoverSlice][1] / tracks.length) * 100)}%
                            </div>
                          </>
                        ) : (
                          <div style={{ fontSize: 12.5, color: t.textDim }}>Hover a slice to see details.</div>
                        )}
                      </div>
                      <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
                        {artistCounts.map(([name, count], i) => (
                          <div key={name}
                            onMouseEnter={() => setHoverSlice(i)}
                            onMouseLeave={() => setHoverSlice(null)}
                            style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12.5,
                              cursor: "pointer", opacity: hoverSlice === null || hoverSlice === i ? 1 : 0.45 }}>
                            <span style={{ width: 10, height: 10, borderRadius: 3, flexShrink: 0,
                              background: SLICE_COLORS[i % SLICE_COLORS.length] }} />
                            <span style={{ flex: 1, color: t.textMuted, whiteSpace: "nowrap",
                              overflow: "hidden", textOverflow: "ellipsis" }}>{name}</span>
                            <span style={{ color: t.textDim, flexShrink: 0 }}>{count}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  </div>
                </>
              )}
            </div>
          </div>
        </div>
      )}

      {bankOpen && (
        <div onMouseDown={(e) => { if (e.target === e.currentTarget) { setBankOpen(false); setBankTargetTrack(null); } }}
          className="vf-overlay" style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.55)",
            display: "grid", placeItems: "center", zIndex: 50 }}>
          <div className="vf-card" onClick={(e) => e.stopPropagation()}
            style={{ width: 620, maxWidth: "90vw", maxHeight: "82vh", background: t.bgCard,
              borderRadius: 16, border: `1px solid ${t.border}`, display: "flex",
              flexDirection: "column", overflow: "hidden", boxShadow: "0 20px 60px rgba(0,0,0,0.4)" }}>
            <div style={{ padding: "18px 22px", borderBottom: `1px solid ${t.border}`,
              display: "flex", alignItems: "center", gap: 12 }}>
              <div style={{ fontSize: 16, fontWeight: 700, flex: 1 }}>Cover bank</div>
              <button onClick={addToBank}
                style={{ display: "inline-flex", alignItems: "center", gap: 7, padding: "7px 13px",
                  borderRadius: 8, border: "none", background: t.green, color: "#fff", cursor: "pointer",
                  fontSize: 13, fontWeight: 600, fontFamily: "inherit" }}>
                <Icon d={ICONS.plus} size={15} /> Upload images
              </button>
              <span onClick={() => { setBankOpen(false); setBankTargetTrack(null); }}
                style={{ cursor: "pointer", color: t.textMuted, display: "grid", placeItems: "center", padding: 4 }}>
                <Icon d={ICONS.x} size={18} />
              </span>
            </div>

            <div style={{ padding: "12px 22px", fontSize: 13, color: t.textMuted,
              borderBottom: `1px solid ${t.border}` }}>
              {bankTargetTrack
                ? "Click a cover to apply it to this track."
                : selectedTracks.size > 0
                ? `Click a cover to apply it to ${selectedTracks.size} selected track${selectedTracks.size !== 1 ? "s" : ""}.`
                : "Upload images to build your bank. Turn on select mode (✓) to apply a cover to many tracks at once."}
            </div>

            <div className="vf-scroll" style={{ padding: 22, overflow: "auto",
              display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(120px, 1fr))", gap: 14 }}>
              {bank.length === 0 ? (
                <div style={{ gridColumn: "1 / -1", textAlign: "center", color: t.textDim,
                  fontSize: 13.5, padding: "30px 0" }}>
                  No covers yet. Click “Upload images” to add some.
                </div>
              ) : bank.map((b) => {
                const clickable = !!bankTargetTrack || selectedTracks.size > 0;
                return (
                  <div key={b.id} style={{ position: "relative" }}>
                    <img src={window.vf.fileUrl(b.path)} alt=""
                      onClick={() => {
                        if (bankTargetTrack) { assignCoverToOne(bankTargetTrack, b.id); setBankOpen(false); setBankTargetTrack(null); }
                        else if (selectedTracks.size > 0) { assignCoverToSelected(b.id); }
                      }}
                      style={{ width: "100%", aspectRatio: "1 / 1", objectFit: "cover",
                        borderRadius: 10, border: `1px solid ${t.border}`, display: "block",
                        cursor: clickable ? "pointer" : "default",
                        transition: "border-color 0.15s" }}
                      onMouseEnter={(e) => { if (clickable) e.currentTarget.style.borderColor = t.green; }}
                      onMouseLeave={(e) => { e.currentTarget.style.borderColor = t.border; }} />
                    <span onClick={() => deleteFromBank(b.id)} title="Delete from bank"
                      style={{ position: "absolute", top: 5, right: 5, width: 24, height: 24,
                        borderRadius: 7, background: t.bgCard2, border: `1px solid ${t.border}`,
                        display: "grid", placeItems: "center", cursor: "pointer", color: t.textMuted }}>
                      <Icon d={ICONS.trash} size={13} />
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
