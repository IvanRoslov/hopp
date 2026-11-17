// Settings → Lessons in the built app: lessons about hopp, about each
// project and unsorted; Close, Move to…, Add to Guardrails, the Closed
// switch, and Triage with a task. The lesson calls of the main process are
// replaced for the test by an in-memory set that follows the contract
// (hopp.about / hopp.project labels) until the daemon half lands. SHOTS_DIR
// keeps screenshots.
import { expect, test, type Page } from '@playwright/test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { World } from './world';

const SHOTS = process.env['SHOTS_DIR'];

async function shot(page: Page, name: string) {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  for (const theme of ['dark', 'light'] as const) {
    await page.evaluate((t) => (document.documentElement.dataset['theme'] = t), theme);
    await page.waitForTimeout(150);
    await page.screenshot({ path: join(SHOTS, `${name}-${theme}.png`), fullPage: true });
  }
}

const task = 'deployment-vybor-versii-node-js-dlya-sbo';
const now = Math.floor(Date.now() / 1000);
const lesson = (id: number, ago: number, about: string | null, role: string, body: string, project = 'lepsto-deployment') => ({
  id, from: task + (role === 'worker' ? '-t4' : ''), body, status: 'new', created_at: now - ago, closed_at: 0,
  labels: { ...(about ? { 'hopp.about': about } : {}), 'hopp.project': project, 'hopp.task': task, 'hopp.role': role },
});
const LESSONS = [
  lesson(1, 7200, 'project', 'orchestrator', 'Проверка содержимого публичных образов (`crane`) падает на `docker-credential-osxkeychain`: нужен `DOCKER_CONFIG` с пустым `config.json`. Стоит прописать это в agent-toolbox или окружении.'),
  lesson(2, 7000, 'project', 'orchestrator', 'Не нашёл, как прочитать env toolkit на staging/prod (`STATIC_BUILD_IMAGE`): `console_toolkit-env_list` требует **appId**, а где его взять — не описано в стартовом тексте/toolbox.'),
  lesson(5, 2400, null, 'orchestrator', "В плане команда `pnpm --filter ./apps/api test -- <файл>` в toolkit игнорирует фильтр и гонит весь набор (~6 мин); для точечных прогонов — `npx vitest run <файлы>` из `apps/api`."),
  lesson(6, 1440, 'hopp', 'worker', "Vault: no convention existed for `verified` pointing at an unmerged toolkit branch. Added the marker 'branch, pending merge'; a documented format would make this mechanical."),
  { ...lesson(3, 90000, 'hopp', 'orchestrator', 'Команда `hopp ask --wait` не печатала id вопроса.'), status: 'closed', closed_at: now - 80000 },
];

test('lessons: grouped by kind, sorted, moved to guardrails, triaged with a task', async () => {
  const w = new World();
  w.seedTask(task, 'Выбор версии Node.js для сборки');
  const file = join(w.home, 'shell', 'state.json');
  const st = JSON.parse(readFileSync(file, 'utf8'));
  st.projects = [
    { slug: 'lepsto-deployment', name: 'Lepsto Deployment', description: '', orchestratorRepo: null, workerRepos: [], guardrails: '', createdAt: 1 },
    { slug: 'site', name: 'Сайт', description: '', orchestratorRepo: null, workerRepos: [], guardrails: '', createdAt: 2 },
  ];
  st.tasks[0].projectSlug = 'lepsto-deployment';
  writeFileSync(file, JSON.stringify(st));
  try {
    const page = await w.start();
    await w.app!.evaluate(({ ipcMain }, seed) => {
      const g = globalThis as unknown as { lessons: typeof seed.lessons; guardrails: Record<string, string> };
      g.lessons = seed.lessons;
      g.guardrails = {};
      const ok = (value: unknown) => ({ ok: true, value });
      const handle = (m: string, fn: (...a: never[]) => unknown) => {
        ipcMain.removeHandler('shell:' + m);
        ipcMain.handle('shell:' + m, (_e, ...a) => fn(...(a as never[])));
      };
      const edit = (id: number, f: (l: (typeof seed.lessons)[number]) => void) => {
        const l = g.lessons.find((x) => x.id === id)!;
        f(l);
        return ok(null);
      };
      handle('listLessons', (status: string) => g.lessons.filter((l) => status === 'all' || l.status === status));
      handle('closeLesson', (id: number) => edit(id, (l) => ((l.status = 'closed'), (l.closed_at = 1))));
      handle('setLessonAbout', (id: number, about: string | null) =>
        edit(id, (l) => {
          const labels = l.labels as Record<string, string>;
          if (about) labels['hopp.about'] = about;
          else delete labels['hopp.about'];
        }),
      );
      handle('setLessonProject', (id: number, slug: string | null) =>
        edit(id, (l) => {
          const labels = l.labels as Record<string, string>;
          if (slug) labels['hopp.project'] = slug;
          else delete labels['hopp.project'];
        }),
      );
      handle('lessonToGuardrails', (id: number) =>
        edit(id, (l) => {
          const slug = (l.labels as Record<string, string>)['hopp.project']!;
          g.guardrails[slug] = (g.guardrails[slug] ?? '') + '- ' + l.body + '\n';
          l.status = 'closed';
        }),
      );
      handle('triageLessonsBrief', (slug: string) => `Разбери открытые уроки проекта ${slug} (\`hopp lessons --project ${slug}\`): исправь, что можно, остальное перенеси в Guardrails и закрой.`);
    }, { lessons: LESSONS });
    await page.reload();
    await page.setViewportSize({ width: 1440, height: 1000 });

    await expect(page.getByTestId('side-lessons')).toHaveText('4');
    await page.getByRole('button', { name: 'Settings' }).click();
    await page.getByRole('tab', { name: 'Lessons · 4' }).click();
    const ids = (testId: string) => page.getByTestId(testId).locator('[data-testid^="lesson-"]').evaluateAll((els) => els.map((e) => e.getAttribute('data-testid')));
    await expect.poll(() => ids('lessons-hopp')).toEqual(['lesson-6']);
    await expect.poll(() => ids('lessons-project-lepsto-deployment')).toEqual(['lesson-2', 'lesson-1']);
    await expect.poll(() => ids('lessons-unsorted')).toEqual(['lesson-5']);
    await expect(page.getByTestId('lesson-1').locator('code').first()).toHaveText('crane');
    await shot(page, '01-open');

    // Sort the unsorted one into the project.
    await page.getByTestId('move-5').click();
    await page.getByRole('menuitemradio', { name: 'About Lepsto Deployment' }).click();
    await expect.poll(() => ids('lessons-project-lepsto-deployment')).toEqual(['lesson-5', 'lesson-2', 'lesson-1']);
    await expect(page.getByText('No open unsorted lessons.')).toBeVisible();

    // Add one to Guardrails: said first, then appended and closed.
    const l1 = page.getByTestId('lesson-1');
    await l1.getByRole('button', { name: 'Add to Guardrails' }).click();
    await expect(l1.getByRole('alertdialog')).toContainText('It will be in every start text of Lepsto Deployment, and the lesson closes.');
    await shot(page, '02-guardrails-confirm');
    await l1.getByRole('alertdialog').getByRole('button', { name: 'Add to Guardrails' }).click();
    await expect(page.getByTestId('lesson-1')).toHaveCount(0);
    const guard = await w.app!.evaluate(() => (globalThis as unknown as { guardrails: Record<string, string> }).guardrails);
    expect(guard['lepsto-deployment']).toContain('DOCKER_CONFIG');
    await expect(page.getByRole('tab', { name: 'Lessons · 3' })).toBeVisible();

    // Closed ones.
    await page.getByRole('switch', { name: 'Show closed lessons' }).click();
    await expect.poll(() => ids('lessons-hopp')).toEqual(['lesson-3']);
    await expect(page.getByTestId('lesson-1')).toBeVisible();
    await shot(page, '03-closed');
    await page.getByRole('switch', { name: 'Show closed lessons' }).click();

    // Triage the project's lessons with a task.
    await page.getByTestId('triage-lepsto-deployment').click();
    await expect(page.getByLabel('What needs to be done?')).toHaveValue(/Разбери открытые уроки проекта lepsto-deployment/);
    await expect(page.getByTestId('pick-project')).toContainText('Lepsto Deployment');
    await shot(page, '04-triage-new-task');

    // The project page counts its open lessons, with a link.
    await page.getByRole('button', { name: 'Settings' }).click();
    await page.getByRole('tab', { name: 'Projects' }).click();
    await page.getByTestId('settings-projects').getByText('Lepsto Deployment').click();
    await expect(page.getByTestId('project-lessons')).toContainText('2 open lessons about this project');
    await shot(page, '05-project-page');
  } finally {
    await w.dispose();
  }
});
