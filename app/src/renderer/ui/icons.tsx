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
