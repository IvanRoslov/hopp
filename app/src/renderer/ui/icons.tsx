// Line icons from the accepted prototype's set, as components.
import type { SVGProps } from 'react';

type P = SVGProps<SVGSVGElement>;
const line = { fill: 'none', stroke: 'currentColor', strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const };

// The hopp mark: two hops, the second higher.
export const LogoMark = (p: P) => (
  <svg width="18" height="18" viewBox="0 0 18 18" strokeWidth={1.6} aria-hidden {...line} {...p}>
    <path d="M2 14c1.6-5 4.4-5 6 0" />
    <path d="M8 14c1.8-7.5 6.2-7.5 8 0" />
  </svg>
);
export const PlusIcon = (p: P) => (
  <svg width="16" height="16" viewBox="0 0 16 16" strokeWidth={1.5} aria-hidden {...line} {...p}>
    <path d="M8 3.5v9M3.5 8h9" />
  </svg>
);
export const DownIcon = (p: P) => (
  <svg width="12" height="12" viewBox="0 0 16 16" strokeWidth={1.6} aria-hidden {...line} {...p}>
    <path d="M4 6l4 4 4-4" />
  </svg>
);
export const CheckIcon = (p: P) => (
  <svg width="14" height="14" viewBox="0 0 16 16" strokeWidth={1.7} aria-hidden {...line} {...p}>
    <path d="M3 8.5l3.2 3L13 4.5" />
  </svg>
);
export const CloseIcon = (p: P) => (
  <svg width="14" height="14" viewBox="0 0 16 16" strokeWidth={1.6} aria-hidden {...line} {...p}>
    <path d="M4 4l8 8M12 4l-8 8" />
  </svg>
);
export const UpIcon = (p: P) => (
  <svg width="16" height="16" viewBox="0 0 16 16" strokeWidth={1.8} aria-hidden {...line} {...p}>
    <path d="M8 13V3.5M4 7.5l4-4 4 4" />
  </svg>
);
export const SlidersIcon = (p: P) => (
  <svg width="16" height="16" viewBox="0 0 16 16" strokeWidth={1.5} aria-hidden {...line} {...p}>
    <path d="M3 5h10M3 11h10" />
    <circle cx="6" cy="5" r="1.5" fill="var(--side)" />
    <circle cx="10" cy="11" r="1.5" fill="var(--side)" />
  </svg>
);
export const ThemeIcon = (p: P) => (
  <svg width="16" height="16" viewBox="0 0 16 16" strokeWidth={1.5} aria-hidden fill="none" stroke="currentColor" {...p}>
    <circle cx="8" cy="8" r="5" />
    <path d="M8 3a5 5 0 0 0 0 10z" fill="currentColor" stroke="none" />
  </svg>
);
export const FolderIcon = (p: P) => (
  <svg width="16" height="16" viewBox="0 0 16 16" strokeWidth={1.4} aria-hidden {...line} {...p}>
    <path d="M2.5 4.5h4l1.5 1.5h5.5v6.5h-11z" />
  </svg>
);
export const RightIcon = (p: P) => (
  <svg width="14" height="14" viewBox="0 0 16 16" strokeWidth={1.6} aria-hidden {...line} {...p}>
    <path d="M6 4l4 4-4 4" />
  </svg>
);
export const ArrowUpIcon = (p: P) => (
  <svg width="14" height="14" viewBox="0 0 16 16" strokeWidth={1.6} aria-hidden {...line} {...p}>
    <path d="M8 13V3.5M4.5 7l3.5-3.5L11.5 7" />
  </svg>
);
export const ArrowDownIcon = (p: P) => (
  <svg width="14" height="14" viewBox="0 0 16 16" strokeWidth={1.6} aria-hidden {...line} {...p}>
    <path d="M8 3v9.5M4.5 9l3.5 3.5L11.5 9" />
  </svg>
);
// GitHub's mark, filled: it names a repository cloned from GitHub.
export const GithubIcon = (p: P) => (
  <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden {...p}>
    <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
  </svg>
);
export const LockIcon = (p: P) => (
  <svg width="12" height="12" viewBox="0 0 12 12" strokeWidth={1.3} aria-hidden {...line} {...p}>
    <rect x="2.5" y="5.5" width="7" height="5" rx="1" />
    <path d="M4 5.5V4a2 2 0 014 0v1.5" />
  </svg>
);
