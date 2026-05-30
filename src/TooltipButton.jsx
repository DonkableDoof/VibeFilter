import React, { useState, useRef } from "react";

// An icon button with a tooltip that fades in and rises slightly on hover.
// The tooltip hides as soon as the button is clicked and won't reappear until
// the pointer leaves and re-enters the button.
export const TooltipButton = ({ label, onClick, disabled, style, t, children }) => {
  const [show, setShow] = useState(false);
  const suppressed = useRef(false); // true after a click, until the pointer leaves

  return (
    <div style={{ position: "relative", display: "inline-flex" }}
      onMouseEnter={() => { if (!suppressed.current) setShow(true); }}
      onMouseLeave={() => { suppressed.current = false; setShow(false); }}>
      <button
        style={style}
        disabled={disabled}
        onClick={(e) => { suppressed.current = true; setShow(false); onClick && onClick(e); }}>
        {children}
      </button>
      <div
        style={{
          position: "absolute", bottom: "calc(100% + 8px)", left: "50%",
          transform: `translateX(-50%) translateY(${show ? "0" : "4px"})`,
          opacity: show ? 1 : 0,
          transition: "opacity 0.15s ease, transform 0.15s ease",
          pointerEvents: "none", whiteSpace: "nowrap",
          background: t.text, color: t.bg,
          fontSize: 12, fontWeight: 600, padding: "5px 9px", borderRadius: 7,
          boxShadow: "0 4px 14px rgba(0,0,0,0.25)", zIndex: 40,
        }}>
        {label}
      </div>
    </div>
  );
};
