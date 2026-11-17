import { describe, expect, it } from 'vitest';
import { profileEffortTag } from './effort';

describe('profileEffortTag', () => {
  it('names the level, says default only where the model has levels, and nothing else', () => {
    expect(profileEffortTag({ effort: 'high' }, ['low', 'high'])).toBe('effort: high');
    expect(profileEffortTag({ effort: 'high' }, null)).toBe('effort: high');
    expect(profileEffortTag({ effort: '' }, ['low', 'high'])).toBe('effort: default');
    expect(profileEffortTag({ effort: '' }, [])).toBeNull();
    expect(profileEffortTag({ effort: '' }, null)).toBeNull();
  });
});
