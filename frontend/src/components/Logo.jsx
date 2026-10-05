import { useEffect, useState } from "react";

// The organization's logo. An admin can upload one in Settings > Logo; until
// then, or when it can't be loaded, the built-in VSB seal shows.
export const DEFAULT_LOGO = "/vsb-seal.png";
const LOGO_URL = "/api/branding/logo";
const CHANGED = "logo-changed";

let version = 0;

// Settings calls this after an upload or reset so every logo on the page and
// the browser tab icon reload.
export function logoChanged() {
  version += 1;
  window.dispatchEvent(new Event(CHANGED));
  updateTabIcon();
}

const currentUrl = () => (version ? `${LOGO_URL}?v=${version}` : LOGO_URL);

export function updateTabIcon() {
  const link = document.querySelector("link[rel='icon']");
  if (!link) return;
  const probe = new Image();
  probe.onload = () => { link.href = probe.src; };
  probe.onerror = () => { link.href = "/vsb-seal-64.png"; };
  probe.src = currentUrl();
}

export default function Logo({ size, className = "logo" }) {
  const [src, setSrc] = useState(currentUrl);
  useEffect(() => {
    const reload = () => setSrc(currentUrl());
    window.addEventListener(CHANGED, reload);
    return () => window.removeEventListener(CHANGED, reload);
  }, []);
  return (
    <img className={className} src={src} alt="" style={{ height: size, maxWidth: size * 3 }}
      onError={() => { if (src !== DEFAULT_LOGO) setSrc(DEFAULT_LOGO); }} />
  );
}
