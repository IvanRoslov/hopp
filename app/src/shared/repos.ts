// Managed clones: repositories the app cloned from GitHub into
// <HOPP_HOME>/repos/<owner>__<repo>. A project keeps them as ordinary paths;
// this names them back as owner/repo for the page.

export const REPOS_DIR = 'repos';

// managedRepoFolder: the folder name for owner/repo. GitHub names are
// [A-Za-z0-9._-]; the folder keeps them as they are, joined by "__", and
// refuses anything else (or a name that is only dots).
export function managedRepoFolder(fullName: string): string | null {
  const m = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/.exec(fullName.trim());
  if (!m) return null;
  const [, owner, repo] = m as unknown as [string, string, string];
  if (/^\.+$/.test(owner) || /^\.+$/.test(repo) || owner.includes('__')) return null;
  return `${owner}__${repo}`;
}

// managedRepoName: owner/repo when path is a managed clone in home, else null.
export function managedRepoName(path: string, home: string): string | null {
  const base = home.replace(/\/+$/, '') + '/' + REPOS_DIR + '/';
  if (!path.startsWith(base)) return null;
  const folder = path.slice(base.length).replace(/\/+$/, '');
  if (!folder || folder.includes('/')) return null;
  const i = folder.indexOf('__');
  if (i <= 0 || i + 2 >= folder.length) return null;
  return folder.slice(0, i) + '/' + folder.slice(i + 2);
}
