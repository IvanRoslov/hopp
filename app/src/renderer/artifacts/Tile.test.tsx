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
    expect(img.getAttribute('src')).toBe('hopp-artifact://3');
    fireEvent.error(img);
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('.af-ph')?.getAttribute('title')).toBe('The file could not be loaded');
  });
});
