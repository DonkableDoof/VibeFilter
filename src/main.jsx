import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App.jsx";

// Catches any render/effect crash so the app shows a message instead of a
// blank window, with a reload button to recover.
class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }
  static getDerivedStateFromError(error) {
    return { error };
  }
  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div style={{
        height: "100vh", display: "flex", flexDirection: "column",
        alignItems: "center", justifyContent: "center", gap: 14, padding: 30,
        background: "#0c0f17", color: "#e7ecf5", textAlign: "center",
        fontFamily: "'DM Sans', system-ui, sans-serif",
      }}>
        <div style={{ fontSize: 18, fontWeight: 700 }}>Something went wrong</div>
        <div style={{ fontSize: 13, color: "#8a99b3", maxWidth: 460 }}>
          {String(this.state.error?.message || this.state.error)}
        </div>
        <button onClick={() => window.location.reload()}
          style={{
            marginTop: 6, padding: "9px 18px", borderRadius: 9, border: "none",
            background: "#5b9dff", color: "#fff", cursor: "pointer",
            fontSize: 13, fontWeight: 600, fontFamily: "inherit",
          }}>
          Reload VibeFilter
        </button>
      </div>
    );
  }
}

createRoot(document.getElementById("root")).render(
  <ErrorBoundary>
    <App />
  </ErrorBoundary>
);
