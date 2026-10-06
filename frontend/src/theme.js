// Light and dark mode. Admins set seven colors for each mode in Settings >
// Appearance; everyone picks Light, Dark or Match device from the menu under
// their name. The other shades the site uses are worked out from those seven.
// The last colors and choice are kept in this browser so the right mode shows
// straight away, before the server answers.

export const COLOR_FIELDS = [
  { key: "head", name: "Header bar", hint: "The top bar with the app name" },
  { key: "acc", name: "Buttons and links", hint: "Main buttons, links and selected items" },
  { key: "bg", name: "Page background", hint: "Behind everything" },
  { key: "card", name: "Panels", hint: "Cards, lists, forms and menus" },
  { key: "text", name: "Text", hint: "Main text" },
  { key: "muted", name: "Secondary text", hint: "Hints, dates and labels" },
  { key: "line", name: "Borders", hint: "Lines around panels and rows" }
];

export const DEFAULT_COLORS = {
  light: { head: "#0f3a40", acc: "#1d63a6", bg: "#f3f4f1", card: "#ffffff", text: "#1d2528", muted: "#56636a", line: "#dde2df" },
  dark: { head: "#0b2428", acc: "#7fb4ea", bg: "#121719", card: "#1b2225", text: "#e4eaec", muted: "#a2afb5", line: "#2f393d" }
};

export const MODE_NAMES = { light: "Light", dark: "Dark", auto: "Match device" };

const STORAGE_KEY = "appearance";
const darkQuery = typeof window !== "undefined" && window.matchMedia ? window.matchMedia("(prefers-color-scheme: dark)") : null;

function load() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
    if (saved && typeof saved === "object") return { light: saved.light || null, dark: saved.dark || null, mode: saved.mode || "auto" };
  } catch {
    // Storage can be blocked; the defaults below still work.
  }
  return { light: null, dark: null, mode: "auto" };
}

let state = load();

function rgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
function toHex(parts) {
  return "#" + parts.map((x) => Math.round(Math.max(0, Math.min(255, x))).toString(16).padStart(2, "0")).join("");
}
export function mix(a, b, amount) {
  const A = rgb(a);
  const B = rgb(b);
  return toHex(A.map((v, i) => v + (B[i] - v) * amount));
}
function luminance(hex) {
  return rgb(hex)
    .map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); })
    .reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i], 0);
}
export function contrast(a, b) {
  const x = luminance(a);
  const y = luminance(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}
// White or near-black, whichever reads better on the color.
export const textOn = (hex) => (contrast(hex, "#ffffff") >= contrast(hex, "#111111") ? "#ffffff" : "#111111");

export const isColor = (value) => /^#[0-9a-f]{6}$/.test(value || "");

export function colorsFor(mode, saved = state) {
  return { ...DEFAULT_COLORS[mode], ...(saved[mode] || {}) };
}

// The CSS variables for one mode's colors.
export function themeVars(colors, mode) {
  const dark = mode === "dark";
  return {
    "--head": colors.head,
    "--on-head": textOn(colors.head),
    "--acc": colors.acc,
    "--on-acc": textOn(colors.acc),
    "--acc-dark": mix(colors.acc, dark ? "#ffffff" : "#000000", dark ? 0.2 : 0.24),
    "--acc-soft": mix(colors.acc, colors.card, dark ? 0.82 : 0.94),
    "--bg": colors.bg,
    "--card": colors.card,
    "--text": colors.text,
    "--muted": colors.muted,
    "--line": colors.line,
    "--line-soft": mix(colors.line, colors.card, 0.5),
    "--field": mix(colors.line, colors.text, dark ? 0.18 : 0.12),
    "--hover": mix(colors.card, colors.text, dark ? 0.06 : 0.035),
    "--thead": mix(colors.card, colors.bg, 0.5),
    "--pill": mix(colors.card, colors.text, dark ? 0.12 : 0.07)
  };
}

// Problems with how readable a mode's colors are, in plain words.
export function readabilityProblems(colors) {
  const problems = [];
  if (contrast(colors.text, colors.card) < 4.5) problems.push("Text is hard to read on Panels.");
  if (contrast(colors.text, colors.bg) < 4.5) problems.push("Text is hard to read on the Page background.");
  if (contrast(colors.muted, colors.card) < 4.5) problems.push("Secondary text is hard to read on Panels.");
  if (contrast(colors.acc, colors.card) < 4.5) problems.push("Links are hard to read on Panels.");
  if (contrast(colors.acc, textOn(colors.acc)) < 4.5) problems.push("Button text is hard to read on the Buttons and links color.");
  if (contrast(colors.head, textOn(colors.head)) < 4.5) problems.push("The app name is hard to read on the Header bar.");
  return problems;
}

export function effectiveMode(mode = state.mode) {
  if (mode === "light" || mode === "dark") return mode;
  return darkQuery?.matches ? "dark" : "light";
}

function paint() {
  const mode = effectiveMode();
  const root = document.documentElement;
  root.dataset.mode = mode;
  root.style.colorScheme = mode;
  for (const [name, value] of Object.entries(themeVars(colorsFor(mode), mode))) root.style.setProperty(name, value);
}

const listeners = new Set();

export function getAppearance() {
  return state;
}

// Takes any of { light, dark, mode } and repaints the page.
export function setAppearance(next) {
  state = { ...state, ...next };
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Not saved in this browser; the page still changes.
  }
  paint();
  listeners.forEach((listener) => listener(state));
}

export function onAppearanceChange(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

darkQuery?.addEventListener?.("change", paint);
paint();
