import { describe, expect, it } from 'vitest';
import { returnedText, submissionOptionKind, submissionOutcome, usableSubmissionOptions } from './submission';

const IVAN = ['Accept: открыть PR и влить все три (app, toolkit-fix, vault)', 'Accept: только открыть PR, сливаю сам', 'Accept: оставить ветки как есть', 'Return'];

describe('submission options', () => {
  it('classifies by how an option starts', () => {
    for (const o of ['Accept', 'accept', 'Accept: open a PR', 'Accept — merge', 'Accept – merge', 'Accept-merge', 'ACCEPT and merge', ...IVAN.slice(0, 3)]) {
      expect(submissionOptionKind(o), o).toBe('accept');
    }
    for (const o of ['Return', 'return: redo it', 'Revise', 'Revise — tone down']) expect(submissionOptionKind(o), o).toBe('return');
    for (const o of ['Accepted', 'Acceptance test', 'Returning', 'Go', 'Merge', '', 'Не принимать']) expect(submissionOptionKind(o), o).toBe('other');
  });

  it('accepts only on an acceptance; anything else returns', () => {
    for (const c of IVAN.slice(0, 3)) expect(submissionOutcome({ choice: c })).toBe('accepted');
    expect(submissionOutcome({ choice: 'Return' })).toBe('returned');
    expect(submissionOutcome({ choice: 'Merge it' })).toBe('returned');
    expect(submissionOutcome({ choice: '' })).toBe('returned');
    expect(submissionOutcome({})).toBe('returned');
  });

  it('offers the options only when one of them accepts', () => {
    expect(usableSubmissionOptions({ options: IVAN })).toEqual(IVAN);
    expect(usableSubmissionOptions({ options: ['Accept', 'Return'] })).toEqual(['Accept', 'Return']);
    expect(usableSubmissionOptions({ options: ['Merge', 'Wait'] })).toBeNull();
    expect(usableSubmissionOptions({ options: [] })).toBeNull();
    expect(usableSubmissionOptions({ options: null })).toBeNull();
  });

  it('says what a returned stage was told', () => {
    expect(returnedText({ choice: 'Return', answer: 'Fix the logo' })).toBe('Fix the logo');
    expect(returnedText({ choice: 'Merge it', answer: '' })).toBe('Merge it');
    expect(returnedText({ choice: '', answer: 'Just text' })).toBe('Just text');
    expect(returnedText({ choice: 'Revise: tone', answer: 'softer' })).toBe('Revise: tone — softer');
  });
});
