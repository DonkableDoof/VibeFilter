// Format seconds as m:ss (e.g. 75 → "1:15").
export const fmtTime = (s) => {
  if (!s || isNaN(s)) return "0:00";
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${sec.toString().padStart(2, "0")}`;
};

// Pick black or white text for legibility on a given hex background colour,
// using the standard relative-luminance formula. Returns "#1a1a1a" or "#ffffff".
export const contrastText = (hex) => {
  if (!hex) return "#ffffff";
  let h = hex.replace("#", "");
  if (h.length === 3) h = h.split("").map((c) => c + c).join("");
  const r = parseInt(h.slice(0, 2), 16) / 255;
  const g = parseInt(h.slice(2, 4), 16) / 255;
  const b = parseInt(h.slice(4, 6), 16) / 255;
  const lin = (c) => (c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
  const luminance = 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
  return luminance > 0.55 ? "#1a1a1a" : "#ffffff";
};

// Resolve a track's display title and artist, in priority order:
//   0. user-set rename overrides (customTitle / customArtist) always win
//   1. a filename shaped like "Artist - Name"
//   2. embedded file metadata (title / artist)
//   3. the raw filename as the title
export const parseName = (tr) => {
  const base = (() => {
    const raw = tr.name;
    const m = raw.match(/^(.*?)\s*[-–—]\s*(.+)$/);
    if (m && m[1].trim() && m[2].trim()) return { title: m[2].trim(), artist: m[1].trim() };
    if (tr.metaTitle) return { title: tr.metaTitle, artist: tr.metaArtist || null };
    return { title: raw, artist: tr.metaArtist || null };
  })();
  return {
    title: tr.customTitle != null && tr.customTitle !== "" ? tr.customTitle : base.title,
    artist: tr.customArtist != null && tr.customArtist !== "" ? tr.customArtist : base.artist,
  };
};
