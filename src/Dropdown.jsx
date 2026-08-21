import React, { useState, useRef, useEffect } from "react";
import { Icon, ICONS } from "./icons.jsx";

// A compact dropdown: shows the current selection, opens a list of options,
// and offers an "add new" action pinned at the bottom.
export const Dropdown = ({ value, options, onSelect, onAddNew, addNewLabel, t, icon, width = 170 }) => {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef(null);

  // Close when clicking anywhere outside.
  useEffect(() => {
    if (!open) return;
    const onDown = (e) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false);
    };
    const onEsc = (e) => { if (e.key === "Escape") setOpen(false); };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onEsc);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onEsc);
    };
  }, [open]);

  const current = options.find((o) => o.id === value);

  return (
    <div ref={wrapRef} style={{ position: "relative", flexShrink: 0 }}>
      <button onClick={() => setOpen((v) => !v)}
        style={{
          display: "inline-flex", alignItems: "center", gap: 8, width,
          padding: "8px 11px", borderRadius: 9, cursor: "pointer",
          background: t.bgCard2, border: `1px solid ${open ? t.green : t.border}`,
          color: t.text, fontSize: 13, fontWeight: 600, fontFamily: "inherit",
          textAlign: "left",
        }}>
        {icon && <Icon d={icon} size={14} />}
        <span style={{ flex: 1, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
          {current ? current.name : "—"}
        </span>
        <Icon d={ICONS.chevronDown} size={14} />
      </button>

      {open && (
        <div className="vf-scroll" style={{
          position: "absolute", top: "calc(100% + 6px)", left: 0, minWidth: width,
          maxHeight: 280, overflow: "auto", zIndex: 80,
          background: t.bgCard, border: `1px solid ${t.border}`, borderRadius: 10,
          boxShadow: "0 10px 30px rgba(0,0,0,0.35)", padding: 5,
        }}>
          {options.map((o) => (
            <button key={o.id}
              onClick={() => { onSelect(o.id); setOpen(false); }}
              onMouseEnter={(e) => (e.currentTarget.style.background = t.bgHover)}
              onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
              style={{
                display: "flex", alignItems: "center", gap: 8, width: "100%",
                padding: "8px 10px", borderRadius: 7, border: "none", background: "transparent",
                cursor: "pointer", fontSize: 13, fontFamily: "inherit", textAlign: "left",
                fontWeight: o.id === value ? 700 : 500,
                color: o.id === value ? t.green : t.text,
              }}>
              <span style={{ width: 14, flexShrink: 0, display: "grid", placeItems: "center" }}>
                {o.id === value && <Icon d={ICONS.check} size={13} />}
              </span>
              <span style={{ flex: 1, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                {o.name}
              </span>
              {o.count != null && (
                <span style={{ color: t.textDim, fontSize: 12 }}>{o.count}</span>
              )}
            </button>
          ))}
          {onAddNew && (
            <>
              <div style={{ height: 1, background: t.border, margin: "4px 6px" }} />
              <button
                onClick={() => { setOpen(false); onAddNew(); }}
                onMouseEnter={(e) => (e.currentTarget.style.background = t.bgHover)}
                onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
                style={{
                  display: "flex", alignItems: "center", gap: 8, width: "100%",
                  padding: "8px 10px", borderRadius: 7, border: "none", background: "transparent",
                  cursor: "pointer", fontSize: 13, fontWeight: 600, fontFamily: "inherit",
                  color: t.green, textAlign: "left",
                }}>
                <span style={{ width: 14, flexShrink: 0, display: "grid", placeItems: "center" }}>
                  <Icon d={ICONS.plus} size={13} />
                </span>
                {addNewLabel}
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
};
