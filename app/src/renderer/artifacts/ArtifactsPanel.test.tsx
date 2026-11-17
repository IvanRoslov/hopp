import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Artifact } from '../../shared/shell';
import { fakeBridge } from '../../../test/bridge';
import { ArtifactsPanel } from './ArtifactsPanel';

afterEach(cleanup);
const flush = () =>
  act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });

const art = (id: number, name: string, version: number, filename: string, mime: string): Artifact => ({
  id, scope: 't', name, version, filename, mime, size: 100, sha256: '', from: 'orch', labels: {}, created_at: id,
});

const doc1 = art(1, 'analysis', 1, 'analysis.md', 'text/markdown');
const doc2 = art(2, 'analysis', 2, 'analysis.md', 'text/markdown; charset=utf-8');
const chart = art(3, 'chart', 1, 'chart.png', 'image/png');
const plain = art(4, 'notes', 1, 'notes.txt', 'text/plain');
const texts = { 1: '# Анализ v1\n\n- пункт', 2: '# Анализ v2\n\n| a | b |\n|-|-|\n| 1 | 2 |\n\n![график](./chart.png) [первая версия](analysis@1)', 4: '# not a heading here' };

async function view(viewing: Artifact) {
  const f = fakeBridge({ shell: { state: { projects: [] }, artifactTexts: texts } });
  const onView = vi.fn();
  render(
    <ArtifactsPanel
      shell={f.bridge.shell}
      pipeline={null}
      artifacts={[doc1, doc2, chart, plain]}
      asks={[]}
      stageFilter=""
      onStageFilter={() => {}}
      viewing={viewing}
      onView={onView}
      onOpenSubmission={() => {}}
    />,
  );
  await flush();
  return onView;
}

describe('the artifact viewer and markdown', () => {
  it('a markdown artifact shows formatted by default; Source shows the raw text', async () => {
    await view(doc2);
    const shown = screen.getByTestId('viewer-markdown');
    expect(shown.querySelector('h1')!.textContent).toBe('Анализ v2');
    expect(shown.querySelector('table')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Rendered' }).getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(screen.getByRole('button', { name: 'Source' }));
    expect(screen.queryByTestId('viewer-markdown')).toBeNull();
    expect(document.querySelector('pre.viewer-text')!.textContent).toContain('# Анализ v2');
  });

  it('images and links naming other artifacts resolve to them', async () => {
    const onView = await view(doc2);
    const shown = screen.getByTestId('viewer-markdown');
    expect(shown.querySelector('img')!.getAttribute('src')).toBe('hopp-artifact://v/3');
    fireEvent.click(within(shown).getByRole('button', { name: 'первая версия' }));
    expect(onView).toHaveBeenCalledWith(doc1);
  });

  it('compare shows both versions formatted, and both as source with the one switch', async () => {
    await view(doc2);
    fireEvent.click(screen.getByRole('button', { name: 'Compare' }));
    await flush();
    expect(screen.getAllByTestId('viewer-markdown').map((m) => m.querySelector('h1')!.textContent)).toEqual(['Анализ v1', 'Анализ v2']);
    fireEvent.click(screen.getByRole('button', { name: 'Source' }));
    expect(screen.queryAllByTestId('viewer-markdown')).toHaveLength(0);
    expect(document.querySelectorAll('pre.viewer-text')).toHaveLength(2);
  });

  it('a plain text artifact has no switch and stays plain', async () => {
    await view(plain);
    expect(screen.queryByRole('button', { name: 'Rendered' })).toBeNull();
    expect(document.querySelector('pre.viewer-text')!.textContent).toBe('# not a heading here');
  });
});
