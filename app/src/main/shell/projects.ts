// Project validation: every check names the form field it belongs to.
import { stat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import type { Project, ProjectInput, Result, ShellError } from '../../shared/shell';
import { SLUG_PATTERN, slugify } from '../../shared/slug';
import type { Runner } from './exec';

export const MAX_SLUG = 40;

export const fail = <T>(code: string, message: string, field?: string): Result<T> => {
  const error: ShellError = { code, message };
  if (field) error.field = field;
  return { ok: false, error };
};

async function isDir(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isDirectory();
  } catch {
    return false;
  }
}

// repoRoot returns the top folder of the git work tree that holds dir, or
// null when dir is not inside one. Read-only.
export async function repoRoot(git: Runner, dir: string): Promise<string | null> {
  try {
    const r = await git(['-C', dir, 'rev-parse', '--show-toplevel']);
    const top = r.stdout.trim();
    return top || null;
  } catch {
    return null;
  }
}

async function checkRepo(git: Runner, dir: string, field: string, label: string): Promise<Result<string>> {
  if (typeof dir !== 'string' || dir.trim() === '') return fail('folder_missing', `${label}: choose a folder`, field);
  if (!isAbsolute(dir)) return fail('folder_not_absolute', `${label}: ${dir} is not an absolute path`, field);
  if (!(await isDir(dir))) return fail('folder_missing', `${label}: ${dir} does not exist`, field);
  const top = await repoRoot(git, dir);
  if (!top) return fail('not_a_git_repo', `${label}: ${dir} is not a git repository`, field);
  return { ok: true, value: top };
}

// validateProject checks input against the other projects and the disk and
// returns the project to store. editing is the slug of the project being
// edited (its own name and slug are not "taken"); hasTasks forbids a slug
// change, because a task's folders and labels carry the slug.
export async function validateProject(
  input: ProjectInput,
  others: Project[],
  git: Runner,
  now: number,
  editing?: { project: Project; hasTasks: boolean },
): Promise<Result<Project>> {
  const name = (input.name ?? '').trim();
  if (!name) return fail('name_required', 'Give the project a name', 'name');
  if (name.includes('\n')) return fail('name_invalid', 'The name must be one line', 'name');
  const rest = others.filter((p) => p.slug !== editing?.project.slug);
  if (rest.some((p) => p.name.toLowerCase() === name.toLowerCase())) {
    return fail('name_taken', `A project named "${name}" already exists`, 'name');
  }
  const slug = (input.slug ?? '').trim() || slugify(name, MAX_SLUG);
  if (!slug || !SLUG_PATTERN.test(slug) || slug.length > MAX_SLUG) {
    return fail('slug_invalid', `The slug must start with a letter and use only a-z, 0-9 and dashes, at most ${MAX_SLUG} characters`, 'slug');
  }
  if (rest.some((p) => p.slug === slug)) return fail('slug_taken', `The slug "${slug}" is taken by another project`, 'slug');
  if (editing && editing.hasTasks && slug !== editing.project.slug) {
    return fail('slug_locked', 'The slug cannot change while the project has tasks', 'slug');
  }

  let orchestratorRepo: string | null = null;
  if (input.orchestratorRepo !== null && input.orchestratorRepo !== undefined && input.orchestratorRepo.trim() !== '') {
    const r = await checkRepo(git, input.orchestratorRepo.trim(), 'orchestratorRepo', 'Worktree for the orchestrator');
    if (!r.ok) return r;
    orchestratorRepo = r.value;
  }
  const workerRepos: string[] = [];
  for (const raw of input.workerRepos ?? []) {
    if (typeof raw !== 'string' || raw.trim() === '') continue;
    const r = await checkRepo(git, raw.trim(), 'workerRepos', 'Worktrees for workers');
    if (!r.ok) return r;
    if (!workerRepos.includes(r.value)) workerRepos.push(r.value);
  }
  if (workerRepos.length > 0 && !orchestratorRepo) {
    return fail('orchestrator_repo_required', 'Workers need a worktree for the orchestrator first', 'orchestratorRepo');
  }

  return {
    ok: true,
    value: {
      slug,
      name,
      description: (input.description ?? '').trim(),
      orchestratorRepo,
      workerRepos,
      guardrails: (input.guardrails ?? '').trim(),
      createdAt: editing?.project.createdAt ?? now,
    },
  };
}
