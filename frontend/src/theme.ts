// Appearance is a per-browser preference; public/theme.js applies it before first paint.
export type Theme = "system" | "light" | "dark";
const KEY = "downkyi:theme";

export function loadTheme(): Theme {
  try {
    const value = localStorage.getItem(KEY);
    return value === "light" || value === "dark" ? value : "system";
  } catch {
    return "system";
  }
}

export function applyTheme(theme: Theme) {
  const root = document.documentElement;
  if (theme === "system") delete root.dataset.theme;
  else root.dataset.theme = theme;
  try {
    if (theme === "system") localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, theme);
  } catch {
    /* Ignore: the choice still applies for this visit. */
  }
}
