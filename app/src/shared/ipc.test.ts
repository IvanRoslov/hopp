import { describe, expect, it } from 'vitest';
import { artifactIdOf, artifactUrl } from './ipc';

describe('artifact URLs', () => {
  it('round-trip the id through the path, never the host', () => {
    expect(artifactUrl(12)).toBe('hopp-artifact://v/12');
    expect(artifactIdOf(artifactUrl(12))).toBe(12);
    expect(new URL(artifactUrl(7)).hostname).toBe('v');
    for (const bad of ['hopp-artifact://12', 'hopp-artifact://v/0', 'hopp-artifact://v/../1', 'hopp-artifact://v/1x', 'file:///v/1']) {
      expect(artifactIdOf(bad), bad).toBeNull();
    }
  });
});
