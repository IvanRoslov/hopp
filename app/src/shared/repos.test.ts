import { describe, expect, it } from 'vitest';
import { managedRepoFolder, managedRepoName } from './repos';

describe('managed repos', () => {
  it('maps owner/repo to a safe folder, keeping dots and capitals', () => {
    expect(managedRepoFolder('IvanRoslov/hopp.dev')).toBe('IvanRoslov__hopp.dev');
    expect(managedRepoFolder('a-b/c_d')).toBe('a-b__c_d');
    for (const bad of ['', 'x', 'a/b/c', '../x', 'a/..', 'a b/c', 'a/b;rm', 'own__er/x', '/x', 'x/']) {
      expect(managedRepoFolder(bad), bad).toBeNull();
    }
  });
  it('names a managed path back, and nothing else', () => {
    expect(managedRepoName('/h/repos/IvanRoslov__hopp.dev', '/h')).toBe('IvanRoslov/hopp.dev');
    expect(managedRepoName('/h/repos/IvanRoslov__hopp.dev/', '/h/')).toBe('IvanRoslov/hopp.dev');
    expect(managedRepoName('/h/repos/x', '/h')).toBeNull();
    expect(managedRepoName('/h/repos/a__b/sub', '/h')).toBeNull();
    expect(managedRepoName('/elsewhere/a__b', '/h')).toBeNull();
  });
});
