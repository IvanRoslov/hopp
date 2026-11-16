// Pipelines: validation with stable ids, and the three starter pipelines the
// app creates once, on a store that has never had any.
import type { Pipeline, PipelineInput, PipelineStage, Result } from '../../shared/shell';
import { SLUG_PATTERN, slugify } from '../../shared/slug';
import { fail } from './projects';

const MAX_STAGES = 50;

function uniqueSlug(base: string, taken: Set<string>, fallback: string): string {
  const b = slugify(base, 32) || fallback;
  let id = b;
  for (let n = 2; taken.has(id); n++) id = `${b}-${n}`;
  taken.add(id);
  return id;
}

// validatePipeline returns the pipeline to store. `editing` is the stored
// pipeline being changed: its id stays, and a stage keeps its id when the
// input names an id that stage had.
export function validatePipeline(input: PipelineInput, others: Pipeline[], now: number, editing?: Pipeline): Result<Pipeline> {
  const name = (input.name ?? '').trim();
  if (!name) return fail('name_required', 'Give the pipeline a name', 'name');
  if (name.includes('\n')) return fail('name_invalid', 'The name must be one line', 'name');
  const rest = others.filter((p) => p.id !== editing?.id);
  if (rest.some((p) => p.name.toLowerCase() === name.toLowerCase())) {
    return fail('name_taken', `A pipeline named "${name}" already exists`, 'name');
  }
  const inStages = input.stages ?? [];
  if (inStages.length === 0) return fail('stages_required', 'Add at least one stage', 'stages');
  if (inStages.length > MAX_STAGES) return fail('stages_too_many', `At most ${MAX_STAGES} stages`, 'stages');

  const known = new Set((editing?.stages ?? []).map((s) => s.id));
  const taken = new Set<string>();
  // Kept ids first, so a new stage never takes the id of a kept one.
  for (const s of inStages) if (s.id && known.has(s.id)) taken.add(s.id);
  const stages: PipelineStage[] = [];
  const seen = new Set<string>();
  for (const [i, s] of inStages.entries()) {
    const sname = (s.name ?? '').trim();
    if (!sname) return fail('stage_name_required', `Stage ${i + 1} needs a name`, `stages[${i}].name`);
    if (sname.includes('\n')) return fail('stage_name_invalid', `The name of stage ${i + 1} must be one line`, `stages[${i}].name`);
    if (stages.some((x) => x.name.toLowerCase() === sname.toLowerCase())) {
      return fail('stage_name_taken', `Two stages are named "${sname}"`, `stages[${i}].name`);
    }
    let id: string;
    if (s.id && known.has(s.id) && !seen.has(s.id) && SLUG_PATTERN.test(s.id)) id = s.id;
    else id = uniqueSlug(sname, taken, 'stage');
    seen.add(id);
    stages.push({ id, name: sname, does: (s.does ?? '').trim(), result: (s.result ?? '').trim(), substages: !!s.substages, approval: !!s.approval });
  }

  const id = editing?.id ?? uniqueSlug(name, new Set(others.map((p) => p.id)), 'pipeline');
  return { ok: true, value: { id, name, stages, createdAt: editing?.createdAt ?? now, updatedAt: now } };
}

type Starter = { name: string; stages: [string, string, string, boolean, boolean][] };

// [name, does, result, substages, approval]
const STARTERS: Starter[] = [
  {
    name: 'Development',
    stages: [
      ['Analyse the problem', 'Read the request and the code it touches; find the cause or the gap; list open questions and ask them.', 'A short note: what is wrong or missing, where, and the questions the human answered.', false, true],
      ['Design', 'Write the spec (what changes and why) and the plan (steps, files, tests, who does what).', 'A spec and a plan, published as artifacts.', false, true],
      ['Implementation', 'Launch workers for the plan\'s steps, review and integrate their work, keep tests green.', 'The change on the task\'s branch, with tests, and a summary of what was done.', true, false],
      ['Verification', 'Run the full checks, try the change the way the human will use it, fix what fails.', 'A report: what was checked, how, and the results.', false, true],
    ],
  },
  {
    name: 'Landing page',
    stages: [
      ['Questions', 'Ask the human what the page is for, for whom, the one action it drives, the brand and the deadline.', 'The answers, summarised in one post.', false, true],
      ['Market and references', 'Study competitors and strong examples; pick references for structure and look.', 'A references board with a sentence on each pick.', false, true],
      ['Block prototype', 'Lay out the page as a sequence of blocks with their purpose and rough content.', 'A block prototype (image or HTML) of the whole page.', false, true],
      ['Build blocks', 'Build each block to the prototype, one substage per block.', 'Each block working on its own, published as artifacts.', true, false],
      ['Assemble', 'Put the blocks together into one responsive page; check it on phone and desktop widths.', 'The assembled page, with screenshots at both widths.', false, true],
      ['Fill with content', 'Write the final copy and place the final images; check every link.', 'The finished page, ready to publish.', false, true],
    ],
  },
  {
    name: 'Promo video',
    stages: [
      ['Script', 'Write the script: the message, the audience, the length, the voice-over and the on-screen text.', 'A script with timings.', false, true],
      ['Storyboard', 'Turn the script into scenes: one frame and one line per scene.', 'A storyboard covering every scene.', false, true],
      ['Scenes', 'Produce each scene as its own substage, following the storyboard.', 'Every scene rendered and published as an artifact.', true, true],
      ['Assembly', 'Cut the scenes together with sound and titles; export at the agreed format.', 'The final video file.', false, true],
    ],
  },
];

export function starterPipelines(now: number): Pipeline[] {
  const out: Pipeline[] = [];
  for (const s of STARTERS) {
    const r = validatePipeline(
      { name: s.name, stages: s.stages.map(([name, does, result, substages, approval]) => ({ name, does, result, substages, approval })) },
      out,
      now,
    );
    if (r.ok) out.push(r.value);
  }
  return out;
}
