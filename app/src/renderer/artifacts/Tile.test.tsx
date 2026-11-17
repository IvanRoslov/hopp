import { cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { fakeShell } from '../../../test/bridge';
import type { Artifact } from '../../shared/shell';
import { ArtifactThumb } from './Tile';

afterEach(cleanup);

const art: Artifact = { id: 3, scope: 's', name: 'shot', version: 1, filename: 'shot.png', mime: 'image/png', size: 1, sha256: 'x', from: 's', labels: {}, created_at: 1 };

describe('ArtifactThumb', () => {
  it('a file that does not load becomes the placeholder, not a broken image', () => {
    const { container } = render(<ArtifactThumb shell={fakeShell().shell} artifact={art} />);
    const img = container.querySelector('img')!;
    expect(img.getAttribute('src')).toBe('hopp-artifact://v/3');
    fireEvent.error(img);
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('.af-ph')?.getAttribute('title')).toBe('The file could not be loaded');
  });

  // Live run: an SVG icon and a small image were cropped by object-fit: cover.
  it('an SVG is drawn whole, not cropped', () => {
    const svg = { ...art, filename: 'icon.svg', mime: 'image/svg+xml' };
    const { container } = render(<ArtifactThumb shell={fakeShell().shell} artifact={svg} />);
    expect(container.querySelector('img')!.classList.contains('af-whole')).toBe(true);
  });

  it('an image smaller than its tile is drawn whole once it loads; a large one fills the tile', () => {
    const { container } = render(<ArtifactThumb shell={fakeShell().shell} artifact={art} />);
    const img = container.querySelector('img')!;
    expect(img.classList.contains('af-whole')).toBe(false);
    const size = (w: number, h: number, cw: number, ch: number) => {
      Object.defineProperty(img, 'naturalWidth', { value: w, configurable: true });
      Object.defineProperty(img, 'naturalHeight', { value: h, configurable: true });
      Object.defineProperty(img, 'clientWidth', { value: cw, configurable: true });
      Object.defineProperty(img, 'clientHeight', { value: ch, configurable: true });
    };
    size(64, 64, 128, 72);
    fireEvent.load(img);
    expect(container.querySelector('img')!.classList.contains('af-whole')).toBe(true);
    const big = render(<ArtifactThumb shell={fakeShell().shell} artifact={{ ...art, id: 4 }} />).container.querySelector('img')!;
    Object.defineProperty(big, 'naturalWidth', { value: 1920, configurable: true });
    Object.defineProperty(big, 'naturalHeight', { value: 1080, configurable: true });
    Object.defineProperty(big, 'clientWidth', { value: 128, configurable: true });
    Object.defineProperty(big, 'clientHeight', { value: 72, configurable: true });
    fireEvent.load(big);
    expect(big.classList.contains('af-whole')).toBe(false);
  });
});
