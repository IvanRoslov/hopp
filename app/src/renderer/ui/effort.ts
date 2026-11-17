// The effort a profile runs with, as the quiet tag rows and pickers show:
// its level, "default" when its model has levels and the profile sets none,
// nothing when the model has no levels or the catalog is not known yet.
import type { ModelProfile } from '../../shared/shell';

export function profileEffortTag(p: Pick<ModelProfile, 'effort'>, efforts: string[] | null): string | null {
  if (p.effort) return 'effort: ' + p.effort;
  return efforts && efforts.length > 0 ? 'effort: default' : null;
}
