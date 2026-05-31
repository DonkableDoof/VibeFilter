// Accent colour pairs (primary + secondary) used for the app's gradients and
// highlights. The first is the original blue/pink. Picked in Settings.
export const ACCENTS = {
  "Blue / Pink":   { light: ["#2f6fed", "#d6469b"], dark: ["#5b9dff", "#f472b6"] },
  "Green / Lime":  { light: ["#1f9d57", "#7cb342"], dark: ["#4ade80", "#a3e635"] },
  "Purple / Pink": { light: ["#7c3aed", "#db2777"], dark: ["#a78bfa", "#f472b6"] },
  "Orange / Red":  { light: ["#ea580c", "#dc2626"], dark: ["#fb923c", "#f87171"] },
  "Teal / Cyan":   { light: ["#0d9488", "#0891b2"], dark: ["#2dd4bf", "#22d3ee"] },
};

// Color schemes for dark and light mode. Every color the app uses comes from here,
// so this is the place to re-skin VibeFilter. `accentName` selects a pair from ACCENTS.
export const buildTheme = (isLight, accentName = "Blue / Pink") => {
  const pair = ACCENTS[accentName] || ACCENTS["Blue / Pink"];
  const [green, orange] = isLight ? pair.light : pair.dark;
  // accentBg is a faint tint of the primary; derive it from the chosen colour.
  const tint = (hex, a) => {
    const h = hex.replace("#", "");
    const r = parseInt(h.slice(0, 2), 16), g = parseInt(h.slice(2, 4), 16), b = parseInt(h.slice(4, 6), 16);
    return `rgba(${r},${g},${b},${a})`;
  };
  return isLight
    ? {
        bg: "#f3f6fb", bgCard: "#ffffff", bgCard2: "#f6f9fd", bgHover: "#eaf1fb",
        border: "#d6e1f0", borderLight: "#e4ecf7",
        text: "#16213a", textMuted: "#5a6b86", textDim: "#90a0bb",
        green, greenDim: "#c5d8f7", greenBg: tint(green, 0.1),
        orange, orangeDim: "#f7d0e7", orangeBg: tint(orange, 0.1),
        accent: green, accentBg: tint(green, 0.08),
        red: "#dc2626", redHover: "#b91c1c",
        shadow: "0 1px 3px rgba(20,40,80,0.07)",
      }
    : {
        bg: "#0c0f17", bgCard: "#151a24", bgCard2: "#1c2330", bgHover: "#232c3c",
        border: "#27303f", borderLight: "#323d4f",
        text: "#e7ecf5", textMuted: "#8a99b3", textDim: "#566179",
        green, greenDim: "#2a4570", greenBg: tint(green, 0.13),
        orange, orangeDim: "#5a2d48", orangeBg: tint(orange, 0.13),
        accent: green, accentBg: tint(green, 0.12),
        red: "#f87171", redHover: "#ef4444",
        shadow: "0 1px 3px rgba(0,0,0,0.35)",
      };
};

// Suggested colors offered when creating new tags.
export const TAG_PALETTE = [
  "#5b9dff", "#f472b6", "#38bdf8", "#a78bfa", "#34d399",
  "#fb7185", "#60a5fa", "#c084fc", "#22d3ee", "#facc15",
];

// Tags the app starts with on first launch.
export const DEFAULT_TAGS = [
  { id: "emotional", label: "Emotional", color: "#f472b6" },
  { id: "chill", label: "Chill", color: "#5b9dff" },
  { id: "silly", label: "Silly", color: "#facc15" },
  { id: "epic", label: "Epic", color: "#a78bfa" },
];
