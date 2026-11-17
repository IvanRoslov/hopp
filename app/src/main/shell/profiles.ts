// Profile names for imported models, as rocket named them (its
// importProfileName and uniqueProfileName, read from rocket at 4f6f383).
export const MAX_PROFILE_NAME = 40;
export const PROFILE_NAME_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;

// importProfileName: the model id for claude-code and deepseek, "codex-" +
// id for codex, "kimi-" + the id without "kimi-code/" for kimi-code (no
// doubled "kimi-"), "pi-" + provider/model for pi without a repeated
// provider; then lowercase, anything outside [a-z0-9-] becomes "-".
export function importProfileName(agent: string, modelId: string): string {
  let base = modelId;
  if (agent === 'codex') base = 'codex-' + modelId;
  else if (agent === 'kimi-code') {
    base = modelId.replace(/^kimi-code\//, '');
    if (!base.startsWith('kimi-')) base = 'kimi-' + base;
  } else if (agent === 'pi') {
    const i = modelId.indexOf('/');
    if (i >= 0) {
      const provider = modelId.slice(0, i);
      let model = modelId.slice(i + 1);
      if (model.startsWith(provider + '-')) model = model.slice(provider.length + 1);
      base = 'pi-' + provider + '/' + model;
    } else base = 'pi-' + modelId;
  }
  let out = '';
  for (const ch of base.toLowerCase()) out += /[a-z0-9-]/.test(ch) ? ch : '-';
  if (agent === 'pi' || agent === 'deepseek') out = out.replace(/^-+|-+$/g, '');
  return out;
}

// uniqueProfileName: base, or base-2, base-3, …, within MAX_PROFILE_NAME.
export function uniqueProfileName(base: string, taken: Set<string>): string {
  const fit = (s: string, suffix: string) =>
    s.length + suffix.length > MAX_PROFILE_NAME ? s.slice(0, MAX_PROFILE_NAME - suffix.length).replace(/-+$/, '') + suffix : s + suffix;
  let name = fit(base, '');
  for (let i = 2; taken.has(name); i++) name = fit(base, '-' + i);
  return name;
}
