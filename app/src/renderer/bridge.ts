import type { HoppBridge } from '../shared/bridge';

// hopp returns the preload bridge. Components take it as a prop default so
// tests can pass a fake.
export function hopp(): HoppBridge {
  return window.hopp;
}
