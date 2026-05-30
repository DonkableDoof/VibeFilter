// Color schemes for dark and light mode. Every color the app uses comes from here,
// so this is the place to re-skin VibeFilter.
export const buildTheme = (isLight) =>
  isLight
    ? {
        bg: "#f3f6fb", bgCard: "#ffffff", bgCard2: "#f6f9fd", bgHover: "#eaf1fb",
        border: "#d6e1f0", borderLight: "#e4ecf7",
        text: "#16213a", textMuted: "#5a6b86", textDim: "#90a0bb",
        green: "#2f6fed", greenDim: "#c5d8f7", greenBg: "#e8f0fe",
        orange: "#d6469b", orangeDim: "#f7d0e7", orangeBg: "#fdeaf5",
        accent: "#2f6fed", accentBg: "rgba(47,111,237,0.08)",
        red: "#dc2626", redHover: "#b91c1c",
        shadow: "0 1px 3px rgba(20,40,80,0.07)",
      }
    : {
        bg: "#0c0f17", bgCard: "#151a24", bgCard2: "#1c2330", bgHover: "#232c3c",
        border: "#27303f", borderLight: "#323d4f",
        text: "#e7ecf5", textMuted: "#8a99b3", textDim: "#566179",
        green: "#5b9dff", greenDim: "#2a4570", greenBg: "#162338",
        orange: "#f472b6", orangeDim: "#5a2d48", orangeBg: "#2e1a28",
        accent: "#5b9dff", accentBg: "rgba(91,157,255,0.12)",
        red: "#f87171", redHover: "#ef4444",
        shadow: "0 1px 3px rgba(0,0,0,0.35)",
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
