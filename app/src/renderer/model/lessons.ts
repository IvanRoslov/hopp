// How the Lessons tab sorts lessons: by their `hopp.about` label into about
// hopp, about a project (grouped by `hopp.project`) and unsorted.
import type { Lesson, LessonAbout, Project } from '../../shared/shell';

export const LESSON_ABOUT = 'hopp.about';
export const LESSON_PROJECT = 'hopp.project';

export function lessonAbout(l: Lesson): LessonAbout | null {
  const v = l.labels?.[LESSON_ABOUT];
  return v === 'hopp' || v === 'project' ? v : null;
}

export interface ProjectLessons {
  // The project's slug; '' for project lessons that name none (or a project
  // that no longer exists, which keeps its slug as the name).
  slug: string;
  name: string;
  known: boolean;
  lessons: Lesson[];
}

export interface LessonGroups {
  hopp: Lesson[];
  projects: ProjectLessons[];
  unsorted: Lesson[];
}

// groupLessons sorts lessons of one status, newest first. Projects follow the
// order of the store; unknown ones come after, then lessons naming none.
export function groupLessons(lessons: Lesson[], projects: Project[]): LessonGroups {
  const newest = [...lessons].sort((a, b) => b.created_at - a.created_at || b.id - a.id);
  const groups: LessonGroups = { hopp: [], projects: [], unsorted: [] };
  const bySlug = new Map<string, ProjectLessons>();
  for (const p of projects) bySlug.set(p.slug, { slug: p.slug, name: p.name, known: true, lessons: [] });
  const extra: ProjectLessons[] = [];
  for (const l of newest) {
    const about = lessonAbout(l);
    if (about === 'hopp') groups.hopp.push(l);
    else if (about === null) groups.unsorted.push(l);
    else {
      const slug = l.labels?.[LESSON_PROJECT] ?? '';
      let g = bySlug.get(slug);
      if (!g) {
        g = { slug, name: slug || 'Project not set', known: false, lessons: [] };
        bySlug.set(slug, g);
        extra.push(g);
      }
      g.lessons.push(l);
    }
  }
  groups.projects = [...projects.map((p) => bySlug.get(p.slug)!), ...extra.sort((a, b) => (a.slug === '' ? 1 : b.slug === '' ? -1 : a.slug.localeCompare(b.slug)))].filter(
    (g) => g.lessons.length > 0,
  );
  return groups;
}

// openLessonsOf: how many open lessons are about project slug.
export function openLessonsOf(lessons: Lesson[] | null, slug: string): number {
  return (lessons ?? []).filter((l) => l.status === 'new' && lessonAbout(l) === 'project' && l.labels?.[LESSON_PROJECT] === slug).length;
}
