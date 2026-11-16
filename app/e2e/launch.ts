import { _electron as electron, type ElectronApplication } from '@playwright/test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const appDir = join(import.meta.dirname, '..');

// launchApp starts the built app with HOPP_HOME pointed at a temp directory
// (or the one given), so a test never reaches ~/.hopp.
export async function launchApp(env: Record<string, string> = {}): Promise<ElectronApplication> {
  const home = env['HOPP_HOME'] ?? mkdtempSync(join(tmpdir(), 'hopp-app-e2e-'));
  return electron.launch({
    args: [appDir],
    cwd: appDir,
    env: { ...(process.env as Record<string, string>), HOPP_HOME: home, ...env },
  });
}
