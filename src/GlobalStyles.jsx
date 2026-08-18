import React from "react";

// App-wide CSS that can't be expressed as inline styles: custom scrollbars,
// focus-outline suppression on track tiles, and native color-swatch styling.
// Driven by the active theme `t` so colors track dark/light mode.
export const GlobalStyles = ({ t }) => (
  <style>{`
    * { box-sizing: border-box; }
    .vf-scroll { scrollbar-width: thin; scrollbar-color: ${t.border} transparent; }
    .vf-scroll::-webkit-scrollbar { width: 10px; }
    .vf-scroll::-webkit-scrollbar-track { background: transparent; }
    .vf-scroll::-webkit-scrollbar-thumb {
      background: ${t.border};
      border-radius: 999px;
      border: 3px solid transparent;
      background-clip: padding-box;
    }
    .vf-scroll::-webkit-scrollbar-thumb:hover {
      background: ${t.green};
      background-clip: padding-box;
    }
    .vf-scroll::-webkit-scrollbar-thumb:active {
      background: ${t.green};
      background-clip: padding-box;
    }
    .vf-scroll::-webkit-scrollbar-corner { background: transparent; }
    button { outline: none !important; }
    button:focus, button:focus-visible, button:active { outline: none !important; }
    .vf-tile { outline: none !important; -webkit-user-select: none; user-select: none; -webkit-user-drag: element; }
    .vf-tile:focus, .vf-tile:focus-visible, .vf-tile:active, .vf-tile:focus-within { outline: none !important; box-shadow: none !important; }
    .vf-tile * { outline: none !important; }
    .vf-swatch { -webkit-appearance: none; appearance: none; border: none; padding: 0; cursor: pointer; background: none; }
    .vf-swatch::-webkit-color-swatch-wrapper { padding: 0; }
    .vf-swatch::-webkit-color-swatch { border: 1px solid rgba(128,128,128,0.4); border-radius: 5px; }

    /* Interaction feedback: buttons and chips lift on hover and press down on click. */
    button { transition: transform 0.12s ease, background-color 0.15s ease,
             border-color 0.15s ease, color 0.15s ease, opacity 0.15s ease; }
    button:not(:disabled):hover { transform: translateY(-1px); }
    button:not(:disabled):active { transform: translateY(0) scale(0.95); }
    .vf-chip { transition: transform 0.12s ease, background-color 0.15s ease,
               border-color 0.15s ease, color 0.15s ease; }
    .vf-chip:hover { transform: translateY(-1px); }
    .vf-chip:active { transform: scale(0.94); }
    .vf-tile:hover { transform: translateY(-3px); }
    .vf-tile:active { transform: translateY(-1px) scale(0.99); }
    @media (prefers-reduced-motion: reduce) {
      button, .vf-chip, .vf-tile, .vf-card, .vf-overlay { transition: none !important; animation: none !important; }
      button:hover, .vf-chip:hover, .vf-tile:hover { transform: none !important; }
    }
    @keyframes vfOverlayIn { from { opacity: 0; } to { opacity: 1; } }    @keyframes vfCardIn { from { opacity: 0; transform: translateY(36px); } to { opacity: 1; transform: translateY(0); } }
    .vf-overlay { animation: vfOverlayIn 0.16s ease-out; }
    .vf-card { animation: vfCardIn 0.42s cubic-bezier(0.16, 1, 0.3, 1); }
  `}</style>
);
