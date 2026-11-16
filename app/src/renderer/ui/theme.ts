// The theme: dark or light, remembered per machine. Until the human picks
// one, the app follows the system.
export type Theme = 'dark' | 'light';
const KEY = 'hopp.theme';

export function storedTheme(): Theme | null {
  try {
    const v = localStorage.getItem(KEY);
    return v === 'dark' || v === 'light' ? v : null;
  } catch {
    return null;
  }
}

export function systemTheme(): Theme {
  try {
    return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  } catch {
    return 'dark';
  }
}

export function applyTheme(t: Theme): void {
  if (t === 'light') document.documentElement.dataset['theme'] = 'light';
  else delete document.documentElement.dataset['theme'];
}

export function initialTheme(): Theme {
  return storedTheme() ?? systemTheme();
}

export function saveTheme(t: Theme): void {
  try {
    localStorage.setItem(KEY, t);
  } catch {
    // Storage may be unavailable; the theme still applies for this session.
  }
}

// onSystemTheme calls cb when the system appearance changes; returns a
// function that stops listening.
export function onSystemTheme(cb: (t: Theme) => void): () => void {
  try {
    const mq = window.matchMedia('(prefers-color-scheme: light)');
    const h = () => cb(mq.matches ? 'light' : 'dark');
    mq.addEventListener('change', h);
    return () => mq.removeEventListener('change', h);
  } catch {
    return () => {};
  }
}
