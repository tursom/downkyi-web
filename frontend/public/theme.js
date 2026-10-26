// Applies a saved light/dark choice before first paint. "Follow system" needs no script:
// styles.css switches on prefers-color-scheme. Kept external because the CSP forbids inline scripts.
try {
  var theme = localStorage.getItem("downkyi:theme");
  if (theme === "light" || theme === "dark") document.documentElement.dataset.theme = theme;
} catch (error) {
  /* Storage unavailable: follow the system. */
}
