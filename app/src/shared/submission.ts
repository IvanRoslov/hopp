// What a submission's options and answer mean. An orchestrator may offer
// more than Accept and Return ("Accept: open a PR", "Accept: keep the
// branches"), so options are classified by how they start, and everything
// that reads a submission (stages, the feed, the Questions column, `hopp task
// show`) uses these two functions.
//
// The rule for an answer: a choice that is an acceptance accepts the stage;
// anything else (a return option, a neutral option, or text with no choice)
// does not, and returns the stage with that answer as what to say. Never
// accepting by default is the safe side: a stage moves on only on an Accept.
import type { Ask } from './types';

export type SubmissionOptionKind = 'accept' | 'return' | 'other';

// Accept / Return / Revise, alone or followed by ":", a space, or a dash.
const ACCEPT_RE = /^accept(?=$|[\s:—–-])/i;
const RETURN_RE = /^(return|revise)(?=$|[\s:—–-])/i;

export function submissionOptionKind(option: string): SubmissionOptionKind {
  const o = option.trim();
  if (ACCEPT_RE.test(o)) return 'accept';
  if (RETURN_RE.test(o)) return 'return';
  return 'other';
}

// submissionOutcome: what an answered submission did to its stage.
export function submissionOutcome(a: Pick<Ask, 'choice'>): 'accepted' | 'returned' {
  return a.choice && submissionOptionKind(a.choice) === 'accept' ? 'accepted' : 'returned';
}

// usableSubmissionOptions: the ask's options when at least one is an
// acceptance; otherwise null, and the page offers them as plain answers.
export function usableSubmissionOptions(a: Pick<Ask, 'options'>): string[] | null {
  const opts = a.options ?? [];
  return opts.some((o) => submissionOptionKind(o) === 'accept') ? opts : null;
}

// returnedText: what a returned stage shows as the human's word: the text of
// what to fix, led by the chosen option when it was not a plain Return.
export function returnedText(a: Pick<Ask, 'choice' | 'answer'>): string {
  const choice = (a.choice ?? '').trim();
  const text = (a.answer ?? '').trim();
  const lead = choice && !/^(return|revise)$/i.test(choice) ? choice : '';
  return [lead, text].filter(Boolean).join(' — ');
}
