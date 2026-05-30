import React from "react";

// App-wide CSS that can't be expressed as inline styles: custom scrollbars,
// focus-outline suppression on track tiles, and native color-swatch styling.
// Driven by the active theme `t` so colors track dark/light mode.
export const GlobalStyles = ({ t }) => (
  <style>{`
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
    .vf-tile { outline: none !important; -webkit-user-select: none; user-select: none; -webkit-user-drag: element; }
    .vf-tile:focus, .vf-tile:focus-visible, .vf-tile:active, .vf-tile:focus-within { outline: none !important; box-shadow: none !important; }
    .vf-tile * { outline: none !important; }
    .vf-swatch { -webkit-appearance: none; appearance: none; border: none; padding: 0; cursor: pointer; background: none; }
    .vf-swatch::-webkit-color-swatch-wrapper { padding: 0; }
    .vf-swatch::-webkit-color-swatch { border: 1px solid rgba(128,128,128,0.4); border-radius: 5px; }
  `}</style>
);
