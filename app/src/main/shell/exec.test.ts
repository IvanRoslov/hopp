import { describe, expect, it } from 'vitest';
import { makeRunner } from './exec';

describe('makeRunner', () => {
  it('a call that runs out of its own timeout is killed and says so', async () => {
    const sleep = makeRunner('/bin/sleep', () => process.env);
    const t0 = Date.now();
    await expect(sleep(['5'], { timeoutMs: 200 })).rejects.toThrow(/timed out after 0\.2 s/);
    expect(Date.now() - t0).toBeLessThan(3_000);
  });
});
