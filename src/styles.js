import { contrastText } from "./helpers";

// Builds the inline-style objects used across the app from the active theme `t`.
// Functions (chip, trackCard) return styles that depend on per-element state.
export const makeStyles = (t) => ({
  app: {
    display: "flex", height: "100vh", overflow: "hidden",
    fontFamily: "'DM Sans','Nunito',system-ui,sans-serif",
    background: t.bg, color: t.text,
  },
  sidebar: {
    width: 280, minWidth: 280, background: t.bgCard,
    borderRight: `1px solid ${t.border}`, display: "flex", flexDirection: "column",
    overflowY: "auto", overflowX: "hidden",
  },
  logo: {
    padding: "20px 18px", paddingTop: 38, display: "flex", alignItems: "center", gap: 10,
    borderBottom: `1px solid ${t.border}`,
  },
  logoMark: {
    width: 34, height: 34, borderRadius: 9, display: "grid", placeItems: "center",
    background: `linear-gradient(135deg, ${t.green}, ${t.orange})`, color: "#fff",
  },
  section: { padding: "16px 18px", borderBottom: `1px solid ${t.border}` },
  label: {
    fontSize: 11, fontWeight: 700, letterSpacing: 0.8, textTransform: "uppercase",
    color: t.textDim, marginBottom: 10,
  },
  main: { flex: 1, display: "flex", flexDirection: "column", minWidth: 0 },
  topbar: {
    padding: "16px 24px", paddingTop: 38, borderBottom: `1px solid ${t.border}`,
    display: "flex", alignItems: "center", gap: 14,
  },
  searchWrap: {
    flex: 1, display: "flex", alignItems: "center", gap: 8, padding: "8px 12px",
    background: t.bgCard2, border: `1px solid ${t.border}`, borderRadius: 9, color: t.textMuted,
  },
  searchInput: {
    flex: 1, background: "transparent", border: "none", outline: "none",
    color: t.text, fontSize: 14, fontFamily: "inherit",
  },
  content: { flex: 1, display: "flex", minHeight: 0 },
  list: {
    flex: 1, overflow: "auto", padding: 24,
  },
  grid: {
    display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(160px, 1fr))",
    gap: 16, alignContent: "start",
  },
  player: {
    width: 340, minWidth: 340, borderLeft: `1px solid ${t.border}`,
    background: t.bgCard, padding: 24, display: "flex", flexDirection: "column",
    overflow: "auto",
  },
  iconBtn: {
    width: 38, height: 38, borderRadius: 9, display: "grid", placeItems: "center",
    background: t.bgCard2, border: `1px solid ${t.border}`, color: t.textMuted, cursor: "pointer",
  },
  chip: (active, color) => ({
    display: "inline-flex", alignItems: "center", gap: 6, padding: "5px 11px",
    borderRadius: 999, fontSize: 12.5, fontWeight: 600, cursor: "pointer",
    userSelect: "none", transition: "border-color 0.15s, transform 0.15s",
    background: active ? color : t.bgCard2,
    color: active ? contrastText(color) : t.textMuted,
    border: `1px solid ${active ? color : t.border}`,
  }),
  trackCard: (active) => ({
    display: "flex", flexDirection: "column", padding: 10,
    background: active ? t.accentBg : t.bgCard, borderRadius: 14,
    border: `1px solid ${active ? t.green : t.border}`, cursor: "grab",
    transition: "border-color 0.15s, transform 0.14s ease, box-shadow 0.15s ease", boxShadow: t.shadow,
    position: "relative",
  }),
  cover: {
    width: "100%", aspectRatio: "1 / 1", borderRadius: 9, objectFit: "cover",
    background: `linear-gradient(135deg, ${t.greenBg}, ${t.orangeBg})`,
    display: "grid", placeItems: "center", color: t.textDim, marginBottom: 10,
  },
});
