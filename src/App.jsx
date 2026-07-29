import React, { useState, useRef, useEffect, useMemo, useCallback } from "react";
import { buildTheme, ACCENTS, TAG_PALETTE, DEFAULT_TAGS } from "./theme";
import { Icon, ICONS } from "./icons.jsx";
import { fmtTime, parseName as parseNameBase } from "./helpers";
import { makeStyles } from "./styles";
import { GlobalStyles } from "./GlobalStyles.jsx";
import { TooltipButton } from "./TooltipButton.jsx";
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
  const [hoverSlice, setHoverSlice] = useState(null); // index of hovered pie slice, or null
  const dragTagIndex = useRef(null);                  // index of tag being dragged
  const [dragOverTag, setDragOverTag] = useState(null); // index currently hovered during tag drag

  const isLight = settings.lightMode;
  const accentName = settings.accent || "Blue / Pink";
  const accentIcon = {
    "Blue / Pink": "./icon-blue-pink.png",
    "Green / Lime": "./icon-green-lime.png",
    "Purple / Pink": "./icon-purple-pink.png",
    "Orange / Red": "./icon-orange-red.png",
    "Teal / Cyan": "./icon-teal-cyan.png",
  }[accentName] || "./app-icon.png";
  const tileSize = settings.tileSize || "medium";
  const setTileSize = (size) => setSettings((p) => ({ ...p, tileSize: size }));
  const nameLast = !!settings.nameLast;
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
        // Migrate any legacy `favorite` key to `favourite`.
        setTracks(lib.tracks.map((tr) =>
          "favorite" in tr ? { ...tr, favourite: tr.favourite ?? tr.favorite, favorite: undefined } : tr));
      }
      if (lib.tags) setTags(lib.tags);
      if (lib.settings) {
        setSettings(lib.settings);
        if (typeof lib.settings.volume === "number") setVolume(lib.settings.volume);
      }
      setLoaded(true);
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
    canvas.width = cssW * dpr; canvas.height = cssH * dpr;
    const ctx = canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);

    const n = peaks.length;
    const gap = 2;
    const barW = (cssW - gap * (n - 1)) / n;
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
      const r = Math.min(barW / 2, 2);
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

  // Static redraw on progress/theme/peaks change (no animation — intro stays at 1).
  useEffect(() => {
    if (introRafRef.current) return; // skip while a wave-in animation is running
    drawWave(1);
  }, [drawWave]);

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
    a.volume = Math.max(0, Math.min(1, sliderVol * gain));
  };

  // Add files (used by the picker and by drag-in), de-duplicating by file path.
  const addTrackObjects = useCallback((objs) => {
    if (!objs || !objs.length) return;
    setTracks((prev) => {
      const existingPaths = new Set(prev.map((p) => p.filePath));
      const fresh = objs.filter((o) => !existingPaths.has(o.filePath));
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
      const objs = await window.vf.processFiles(paths);
      addTrackObjects(objs);
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
      const matchUsed = !hideUsed || !tr.used;
      return matchSearch && matchTags && matchExcluded && matchFavs && matchUsed;
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
  const usedCount = tracks.filter((tr) => tr.used).length;

  // "Title — Artist" lines for every used track, sorted by artist then title.
  // Handy for pasting into a YouTube description.
  const creditsText = () =>
    tracks
      .filter((tr) => tr.used)
      .map((tr) => parseName(tr))
      .sort((a, b) => {
        const byArtist = (a.artist || "").localeCompare(b.artist || "", undefined, { sensitivity: "base" });
        return byArtist !== 0 ? byArtist : a.title.localeCompare(b.title, undefined, { sensitivity: "base" });
      })
      .map(({ title, artist }) => (artist ? `${artist} — ${title}` : title))
      .join("\n");

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

  // Play the next track in the current list order, wrapping to the first at the end.
  // Independent of shuffle — shuffle only picks the *current* random track.
  const playNext = () => {
    const pool = filtered;
    if (pool.length === 0) return;
    const idx = pool.findIndex((tr) => tr.id === selectedId);
    const next = idx === -1 ? pool[0] : pool[(idx + 1) % pool.length];
    selectTrack(next);
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

  // Hand a track off to the OS so it can be dragged into Premiere / Explorer,
  // and mark it "used" so it can be hidden until the user resets.
  const onTrackDragStart = (e, tr) => {
    e.preventDefault();
    window.vf.startDrag(tr.filePath);
    // usedAt lets "Undo use" find the most recently used track, even after a restart.
    setTracks((prev) => prev.map((x) => (x.id === tr.id ? { ...x, used: true, usedAt: Date.now() } : x)));
  };
  const resetUsed = () => {
    setTracks((prev) => prev.map((tr) => (tr.used ? { ...tr, used: false, usedAt: null } : tr)));
  };
  // Mark a single track used / unused (from the right-click menu).
  const setTrackUsed = (id, used) => {
    setTracks((prev) => prev.map((tr) =>
      tr.id === id ? { ...tr, used, usedAt: used ? Date.now() : null } : tr));
  };
  // Un-use whichever track was used most recently.
  const undoLastUse = () => {
    const used = tracks.filter((tr) => tr.used);
    if (used.length === 0) return;
    const latest = used.reduce((a, b) => ((b.usedAt || 0) > (a.usedAt || 0) ? b : a));
    setTrackUsed(latest.id, false);
  };

  // ── 7. Render ─────────────────────────────────────────────────────────────
  const s = makeStyles(t);
  const empty = tracks.length === 0;
  const tileMin = { small: 110, medium: 160, large: 230 }[tileSize];

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

      <aside style={s.sidebar}>
        <div style={s.logo}>
          <img src={accentIcon} alt="VibeFilter" style={{ width: 34, height: 34, borderRadius: 9 }} />
          <div>
            <div style={{ fontSize: 16, fontWeight: 700, letterSpacing: -0.3 }}>VibeFilter</div>
          </div>
        </div>

        <div style={s.section}>
          <div style={s.label}>Filter by vibe</div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 7 }}>
            <span style={{ ...s.chip(favsOnly, "#facc15"), padding: "5px 9px" }}
              title="Show only favourites"
              onClick={() => setFavsOnly((v) => !v)}>
              <Icon d={ICONS.star} size={14} fill={favsOnly ? "currentColor" : "none"} />
            </span>
            {tags.map((tg) => {
              const included = activeFilters.includes(tg.id);
              const excluded = excludedFilters.includes(tg.id);
              return (
                <span key={tg.id}
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
          {(activeFilters.length > 0 || excludedFilters.length > 0 || favsOnly) && (
            <div onClick={clearFilters}
              style={{ marginTop: 10, fontSize: 12, color: t.green, cursor: "pointer", fontWeight: 600 }}>
              Clear filters
            </div>
          )}
          <div style={{ marginTop: 12, display: "flex", alignItems: "center", gap: 7, flexWrap: "wrap" }}>
            <span onClick={() => setHideUsed((v) => !v)}
              title={hideUsed ? "Used tracks are hidden" : "Used tracks are shown"}
              style={{ ...s.chip(hideUsed, t.green), padding: "5px 10px", gap: 6 }}>
              <Icon d={ICONS.check} size={13} /> Hide used
            </span>
            {usedCount > 0 && (
              <span onClick={undoLastUse} title="Un-use the most recently used track"
                style={{ ...s.chip(false, t.green), padding: "5px 10px", gap: 6 }}>
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
          <button onClick={openAddTag}
            style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 7,
              width: "100%", padding: "8px 10px", marginBottom: 10, borderRadius: 8,
              border: `1px dashed ${t.border}`, background: t.bgCard2, color: t.textMuted,
              cursor: "pointer", fontSize: 13, fontWeight: 600, fontFamily: "inherit" }}>
            <Icon d={ICONS.plus} size={15} /> Add tag
          </button>
          <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
            {tags.map((tg, i) => (
              <div key={tg.id}
                draggable
                onDragStart={() => { dragTagIndex.current = i; }}
                onDragOver={(e) => { e.preventDefault(); setDragOverTag(i); }}
                onDragLeave={() => setDragOverTag((cur) => (cur === i ? null : cur))}
                onDrop={(e) => { e.preventDefault(); reorderTags(dragTagIndex.current, i); dragTagIndex.current = null; setDragOverTag(null); }}
                onDragEnd={() => { dragTagIndex.current = null; setDragOverTag(null); }}
                style={{ display: "flex", alignItems: "center", gap: 7, fontSize: 13,
                  padding: "2px 0", borderRadius: 6,
                  borderTop: `2px solid ${dragOverTag === i && dragTagIndex.current !== null ? t.green : "transparent"}` }}>
                <span style={{ cursor: "grab", color: t.textDim, display: "grid", placeItems: "center", flexShrink: 0 }}
                  title="Drag to reorder">
                  <Icon d={ICONS.grip} size={14} />
                </span>
                <input type="color" className="vf-swatch" value={tg.color}
                  title="Change colour"
                  onChange={(e) => setTagColor(tg.id, e.target.value)}
                  style={{ width: 16, height: 16, flexShrink: 0, borderRadius: 5 }} />
                <span style={{ flex: 1, color: t.textMuted, whiteSpace: "nowrap",
                  overflow: "hidden", textOverflow: "ellipsis" }}>{tg.label}</span>
                <span onClick={() => removeTag(tg.id)}
                  title="Delete tag"
                  onMouseEnter={(e) => (e.currentTarget.style.color = t.textMuted)}
                  onMouseLeave={(e) => (e.currentTarget.style.color = t.textDim)}
                  style={{ cursor: "pointer", color: t.textDim, display: "grid", placeItems: "center", flexShrink: 0 }}>
                  <Icon d={ICONS.x} size={14} />
                </span>
              </div>
            ))}
          </div>
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
                            opacity: tr.used && !active ? 0.45 : 1,
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
                            {!selectMode && tr.used && (
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

          <aside style={s.player} className="vf-scroll">
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

                <div style={{ display: "flex", justifyContent: "center", alignItems: "center", gap: 18, marginBottom: 18 }}>
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
                        style={s.chip(on, tg.color)}>{tg.label}</span>
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
            top: Math.min(ctxMenu.y, window.innerHeight - 230), zIndex: 61,
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
              onClick={() => { setTrackUsed(ctxMenu.trackId, !(ctxTrack && ctxTrack.used)); setCtxMenu(null); }}
              onMouseEnter={(e) => (e.currentTarget.style.background = t.bgHover)}
              onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
              style={{ ...itemBase, color: ctxTrack && ctxTrack.used ? t.green : t.text }}>
              <Icon d={ctxTrack && ctxTrack.used ? ICONS.undo : ICONS.check} size={15} />
              {ctxTrack && ctxTrack.used ? "Mark as unused" : "Mark as used"}
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

      {addTagOpen && (
        <div onClick={() => setAddTagOpen(false)}
          className="vf-overlay" style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.55)",
            display: "grid", placeItems: "center", zIndex: 70 }}>
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
        <div onClick={() => setRenaming(null)}
          className="vf-overlay" style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.55)",
            display: "grid", placeItems: "center", zIndex: 70 }}>
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
        <div onClick={() => setSettingsOpen(false)}
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

              {/* Credits for used tracks */}
              <div style={s.label}>Credits</div>
              <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 20 }}>
                <button onClick={copyCredits} disabled={usedCount === 0}
                  style={{ display: "inline-flex", alignItems: "center", gap: 8, padding: "9px 14px",
                    borderRadius: 9, border: "none", fontFamily: "inherit", fontSize: 13, fontWeight: 600,
                    cursor: usedCount ? "pointer" : "not-allowed",
                    background: usedCount ? t.green : t.bgCard2,
                    color: usedCount ? "#fff" : t.textDim }}>
                  <Icon d={creditsCopied ? ICONS.check : ICONS.clipboard} size={15} />
                  {creditsCopied ? "Copied!" : "Copy credits"}
                </button>
                <span style={{ fontSize: 12.5, color: t.textDim }}>
                  {usedCount > 0
                    ? `${usedCount} used track${usedCount !== 1 ? "s" : ""}`
                    : "No used tracks yet"}
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
        <div onClick={() => { setBankOpen(false); setBankTargetTrack(null); }}
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
