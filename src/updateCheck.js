// Checks GitHub for a newer release than the one currently running.
//
// ↓↓↓ EDIT THESE TWO LINES with your GitHub username and repo name ↓↓↓
export const GITHUB_USER = "DonkableDoof";
export const GITHUB_REPO = "vibefilter";
// ↑↑↑ e.g. GITHUB_USER = "duckabledev", GITHUB_REPO = "vibefilter" ↑↑↑

export const REPO_URL = `https://github.com/${GITHUB_USER}/${GITHUB_REPO}`;

// Turn "v1.2.0" or "1.2.0" into [1, 2, 0] for numeric comparison.
const parseVersion = (v) =>
  String(v || "").replace(/^v/i, "").split(".").map((n) => parseInt(n, 10) || 0);

// Returns true if `latest` is a newer version than `current`.
// Compares numerically so 1.10.0 correctly beats 1.9.0.
export const isNewer = (latest, current) => {
  const a = parseVersion(latest);
  const b = parseVersion(current);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] || 0, y = b[i] || 0;
    if (x > y) return true;
    if (x < y) return false;
  }
  return false;
};

// Asks GitHub for the latest release tag. Resolves to the tag string
// (e.g. "v1.2.0") or null if offline / no releases / any error.
export const fetchLatestRelease = async () => {
  try {
    const res = await fetch(
      `https://api.github.com/repos/${GITHUB_USER}/${GITHUB_REPO}/releases/latest`,
      { headers: { Accept: "application/vnd.github+json" } }
    );
    if (!res.ok) return null;
    const data = await res.json();
    return data.tag_name || null;
  } catch {
    return null; // offline or blocked — silently do nothing
  }
};
