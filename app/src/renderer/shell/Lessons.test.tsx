import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Lesson } from '../../shared/shell';
import { fakeBridge, makeProject, makeTask } from '../../../test/bridge';
import { makeLesson } from '../../../test/fakeDaemon';
import { groupLessons } from '../model/lessons';

vi.mock('../terminal/Terminal', () => ({ Terminal: () => <div data-testid="terminal" /> }));
const { ShellApp } = await import('./ShellApp');

const flush = () =>
  act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });

beforeEach(() => localStorage.clear());
afterEach(cleanup);

const now = Math.floor(Date.now() / 1000);
const L = (id: number, about: string | null, over: Partial<Lesson> & { project?: string } = {}) =>
  makeLesson(id, {
    from: 'site-fix-orch',
    created_at: now - id * 60,
    labels: {
      ...(about ? { 'hopp.about': about } : {}),
      ...(over.project ? { 'hopp.project': over.project } : {}),
      'hopp.task': 'site-fix',
      'hopp.role': 'orchestrator',
    },
    ...over,
  });

const lessons = () => [
  L(1, 'hopp', { body: 'Команда `hopp ask --wait` должна печатать **id** вопроса.' }),
  L(2, 'project', { project: 'site', body: 'Перед сборкой запускать `pnpm install --frozen-lockfile`.' }),
  L(3, 'project', { project: 'shop', body: 'Тесты платежей идут только с `STRIPE_TEST=1`.' }),
  L(4, null, { body: 'Неясно, куда писать заметки.' }),
  L(5, 'hopp', { body: 'Закрытый урок', status: 'closed', closed_at: now }),
];

async function open(seed: Lesson[] = lessons()) {
  const f = fakeBridge({
    shell: {
      state: {
        projects: [makeProject('site', { name: 'Сайт' }), makeProject('shop', { name: 'Магазин' })],
        tasks: [makeTask('site-fix', 'site', { title: 'Починить сборку' })],
      },
      lessons: seed,
    },
  });
  render(<ShellApp bridge={f.bridge} />);
  await flush();
  await flush();
  fireEvent.click(screen.getByText('Settings'));
  fireEvent.click(screen.getByRole('tab', { name: /Lessons/ }));
  await flush();
  return f;
}
const ids = (el: HTMLElement) => [...el.querySelectorAll('[data-testid^="lesson-"]')].map((e) => e.getAttribute('data-testid'));

describe('grouping', () => {
  it('sorts by hopp.about, project lessons by hopp.project in store order, newest first', () => {
    const g = groupLessons(
      [L(1, 'hopp'), L(2, 'project', { project: 'shop' }), L(3, 'project', { project: 'site' }), L(4, null), L(5, 'project'), L(6, 'project', { project: 'gone' }), L(7, 'bogus')],
      [makeProject('site', { name: 'Сайт' }), makeProject('shop', { name: 'Магазин' })],
    );
    expect(g.hopp.map((l) => l.id)).toEqual([1]);
    expect(g.projects.map((p) => [p.name, p.known, p.lessons.map((l) => l.id)])).toEqual([
      ['Сайт', true, [3]],
      ['Магазин', true, [2]],
      ['gone', false, [6]],
      ['Project not set', false, [5]],
    ]);
    expect(g.unsorted.map((l) => l.id)).toEqual([4, 7]);
  });
});

describe('the Lessons tab', () => {
  it('shows open lessons in three groups with counts, ids, markdown, who and the task', async () => {
    await open();
    expect(screen.getByRole('tab', { name: 'Lessons · 4' })).toBeTruthy();
    expect(ids(screen.getByTestId('lessons-hopp'))).toEqual(['lesson-1']);
    expect(ids(screen.getByTestId('lessons-project-site'))).toEqual(['lesson-2']);
    expect(ids(screen.getByTestId('lessons-project-shop'))).toEqual(['lesson-3']);
    expect(ids(screen.getByTestId('lessons-unsorted'))).toEqual(['lesson-4']);
    expect(screen.getByTestId('lessons-projects').textContent).toContain('Open lessons of a project are given to its next tasks until you close them or move them to Guardrails.');
    const row = screen.getByTestId('lesson-1');
    expect(row.querySelector('.lesson-id')!.textContent).toBe('#1');
    expect(row.querySelector('code')!.textContent).toBe('hopp ask --wait');
    expect(row.querySelector('strong')!.textContent).toBe('id');
    expect(row.querySelector('.meta')!.textContent).toContain('orchestrator');
    expect(row.querySelector('.meta')!.textContent).toContain('site-fix-orch');
    fireEvent.click(within(row).getByRole('button', { name: 'Починить сборку' }));
    expect(screen.getByTestId('work-view')).toBeTruthy();
  });

  it('the Closed switch shows the closed ones; every group says when it is empty', async () => {
    await open();
    fireEvent.click(screen.getByRole('switch', { name: 'Show closed lessons' }));
    expect(ids(screen.getByTestId('lessons-hopp'))).toEqual(['lesson-5']);
    expect(screen.getByText('No closed lessons about projects.')).toBeTruthy();
    expect(screen.getByText('No closed unsorted lessons.')).toBeTruthy();
    expect(within(screen.getByTestId('lesson-5')).queryByRole('button', { name: 'Close' })).toBeNull();
  });

  it('Close closes and the lesson leaves the open list', async () => {
    const f = await open();
    fireEvent.click(within(screen.getByTestId('lesson-4')).getByRole('button', { name: 'Close' }));
    await flush();
    expect(f.shell!.closeLesson).toHaveBeenCalledWith(4);
    expect(screen.queryByTestId('lesson-4')).toBeNull();
    expect(screen.getByText('No open unsorted lessons.')).toBeTruthy();
    expect(screen.getByRole('tab', { name: 'Lessons · 3' })).toBeTruthy();
  });

  it('Move to… sorts a lesson to hopp, to a project, or back to unsorted', async () => {
    const f = await open();
    const move = async (id: number, to: string) => {
      fireEvent.click(screen.getByTestId(`move-${id}`));
      fireEvent.click(screen.getByRole('menuitemradio', { name: to }));
      await flush();
    };
    await move(4, 'About Магазин');
    expect(f.shell!.setLessonProject).toHaveBeenCalledWith(4, 'shop');
    expect(f.shell!.setLessonAbout).toHaveBeenCalledWith(4, 'project');
    expect(ids(screen.getByTestId('lessons-project-shop'))).toEqual(['lesson-3', 'lesson-4']);
    await move(2, 'About hopp');
    expect(f.shell!.setLessonAbout).toHaveBeenCalledWith(2, 'hopp');
    expect(ids(screen.getByTestId('lessons-hopp'))).toEqual(['lesson-1', 'lesson-2']);
    await move(1, 'Unsorted');
    expect(f.shell!.setLessonAbout).toHaveBeenCalledWith(1, null);
    expect(ids(screen.getByTestId('lessons-unsorted'))).toEqual(['lesson-1']);
  });

  it('Add to Guardrails says what it does first, then appends and closes', async () => {
    const f = await open();
    const row = screen.getByTestId('lesson-2');
    expect(within(screen.getByTestId('lesson-1')).queryByRole('button', { name: 'Add to Guardrails' })).toBeNull();
    fireEvent.click(within(row).getByRole('button', { name: 'Add to Guardrails' }));
    expect(within(row).getByRole('alertdialog').textContent).toContain('It will be in every start text of Сайт, and the lesson closes.');
    fireEvent.click(within(within(row).getByRole('alertdialog')).getByRole('button', { name: 'Add to Guardrails' }));
    await flush();
    expect(f.shell!.lessonToGuardrails).toHaveBeenCalledWith(2);
    expect(screen.queryByTestId('lesson-2')).toBeNull();
  });

  it('Copy text puts the lesson on the clipboard', async () => {
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    await open();
    fireEvent.click(within(screen.getByTestId('lesson-3')).getByRole('button', { name: 'Copy text' }));
    await flush();
    expect(writeText).toHaveBeenCalledWith('Тесты платежей идут только с `STRIPE_TEST=1`.');
    expect(within(screen.getByTestId('lesson-3')).getByRole('button', { name: 'Copied' })).toBeTruthy();
  });

  it('Triage with a task… opens New task for the project with the brief filled in', async () => {
    const f = await open();
    fireEvent.click(screen.getByTestId('triage-site'));
    await flush();
    expect(f.shell!.triageLessonsBrief).toHaveBeenCalledWith('site');
    expect((screen.getByLabelText('What needs to be done?') as HTMLTextAreaElement).value).toContain('Разбери открытые уроки проекта site');
    expect(screen.getByTestId('pick-project').textContent).toContain('Сайт');
  });
});

describe('open lesson counts elsewhere', () => {
  it('beside Settings in the left column, and on the project page with a link', async () => {
    await open();
    expect(screen.getByTestId('side-lessons').textContent).toBe('4');
    expect(screen.getByTestId('side-lessons').getAttribute('title')).toBe('4 open lessons');
    fireEvent.click(screen.getByRole('tab', { name: 'Projects' }));
    fireEvent.click(within(screen.getByTestId('settings-projects')).getByText('Сайт'));
    await flush();
    expect(screen.getByTestId('project-lessons').textContent).toContain('1 open lesson about this project');
    fireEvent.click(within(screen.getByTestId('project-lessons')).getByRole('button', { name: 'See them' }));
    expect(screen.getByTestId('settings-lessons')).toBeTruthy();
  });
});

describe('when an agent changes lessons', () => {
  it('a lesson.* event and the window coming back re-read the list', async () => {
    const f = await open();
    const calls = () => (f.shell!.listLessons as ReturnType<typeof vi.fn>).mock.calls.length;
    const before = calls();
    // An agent closes #4 with `hopp lesson close 4`.
    await f.shell!.closeLesson(4);
    f.emit('lesson.closed', 'site-fix-orch', { id: 4 });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 250));
    });
    expect(calls()).toBeGreaterThan(before);
    expect(screen.queryByTestId('lesson-4')).toBeNull();
    // A relabel announced by nothing shows once the window is focused again.
    await f.shell!.setLessonAbout(3, 'hopp');
    act(() => {
      window.dispatchEvent(new Event('focus'));
    });
    await flush();
    expect(ids(screen.getByTestId('lessons-hopp'))).toEqual(['lesson-1', 'lesson-3']);
  });
});
