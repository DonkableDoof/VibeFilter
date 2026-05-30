// Format seconds as m:ss (e.g. 75 → "1:15").
export const fmtTime = (s) => {
  if (!s || isNaN(s)) return "0:00";
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${sec.toString().padStart(2, "0")}`;
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
