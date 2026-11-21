---
last-verified: 2026-11-17
---

# Verify a change

## When to use

You are about to check a claim, build a change, or call a change done. These are the standing rules for proving things: what counts as evidence, and what only looks like it. Each rule came from a run where the evidence lied; the line under each rule is its why.

The starting rules were distilled from lessons in another knowledge base of ours and link there. When a lesson of this project confirms or sharpens a rule, add it to the rule's Why line; when it adds a rule, write it once here (see [[docs/playbooks/consolidate-lessons]]).

Running several workers at once has its own rules in [[docs/playbooks/run-parallel-workers]]. The tool for each check is in [[docs/agent-toolbox]]. What is true about the system today is in the fact tree, starting at [[INDEX]].

## Steps

1. Before you plan, check the premise with the rules in "Before you act".
2. While you design and write tests, apply "While you build".
3. Before you report done, collect the evidence in "Before you call it done".
4. Before merge, apply "Shipping it".

## Before you act

**Read the artefact that decides the claim.** Before you repeat a claim, name the thing that would change if the claim were false, and read that one: a package version from the consumer's manifest and the registry, a runtime behaviour from the source file that sets it, which host answered from DNS or the remote IP, never from a status code. A source one level too high reads as confirmation, not as wrong.
Why: [check a claim with the instrument that decides it](https://github.com/lepsto/lepsto-mail-docs/blob/main/docs/lessons/check-a-claim-with-the-instrument-that-decides-it.md)

**Confirm against origin, not a copy.** A local clone, a mirror, a published package and a summary field can all be well-formed and out of date, and none of them says so. Read origin. A presence check is not a freshness check. Prefer the event over the summary field.
Why: [staleness that does not announce itself](https://github.com/lepsto/lepsto-mail-docs/blob/main/docs/lessons/staleness-that-does-not-announce-itself.md)

**When two people disagree, compare sources first.** Name the artefact each of you read before arguing the conclusion.
Why: [staleness that does not announce itself](https://github.com/lepsto/lepsto-mail-docs/blob/main/docs/lessons/staleness-that-does-not-announce-itself.md)

**Read a ported behaviour before you expect it.** An expectation about code carried over from another system goes into a plan or a test only after you have read it in that system's code or docs, quoted. An assumed expectation turns an inherited behaviour into a false regression.
Why: [[docs/lessons/read-ported-behaviour-from-the-code-before-expecting-it]]

**Learn what a tool records from its own state.** When an external tool stops a launch or a flow, reproduce it in a throwaway, take the human's step once, and diff the tool's state files before and after. That diff says what the tool reads; the older system's code says only what it used to write.
Why: [[docs/lessons/claude-code-trusts-a-worktree-through-its-main-repository]]

**"Pre-existing" means reproduced on the commit before the suspect change.** Reproducing a failure on current `main` only rules out your own branch. Bisect `<suspect>^` against `<suspect>`.
Why: [a stub that answers everything hides the screen it broke](https://github.com/lepsto/lepsto-mail-docs/blob/main/docs/lessons/a-stub-that-answers-everything-hides-the-screen-it-broke.md)

## While you build

**Gate irreversible behaviour on a switch you own.** A gate built from variables someone else owns tests nothing once they set them. Log the success as well as the refusals, in a line that cannot be confused with a refusal; absence of a refusal line proves nothing.
Why: [own the switch that turns your feature on](https://github.com/lepsto/lepsto-mail-docs/blob/main/docs/lessons/own-the-switch-that-turns-your-feature-on.md)

**Rank a dependency bump by the surface you use, not by version distance.** Grep the symbols you import. Check whether error reporting moved between channels (throw to return value, sync to async): the compiler cannot see that move. A green suite after a bump proves only the old behaviours.
Why: [version jump size does not predict breakage](https://github.com/lepsto/lepsto-mail-docs/blob/main/docs/lessons/version-jump-size-does-not-predict-breakage.md)

**Stub exact routes, never a prefix, and make the fallback loud.** A catch-all stub answers a new endpoint with the wrong shape and the failure shows up far away. An unmatched path must fail the test and name the URL.
Why: [a stub that answers everything hides the screen it broke](https://github.com/lepsto/lepsto-mail-docs/blob/main/docs/lessons/a-stub-that-answers-everything-hides-the-screen-it-broke.md)

**A name you hand to another system lives in its namespace.** A session id is also a tmux session name, shared by every tmux user on the machine. When a name is accepted, check every place it will land (tmux sessions, mailboxes, folders, branches) and say the reason next to the name, not at the first use.
Why: [[docs/lessons/a-session-id-is-a-name-in-every-tmux-on-the-machine]]

**Refuse empty input where it enters.** A command that takes text from an argument, a file or stdin takes it from exactly one source and refuses an empty pipe, a terminal on stdin and a blank text, never sending nothing on.
Why: [[docs/lessons/a-command-that-reads-stdin-refuses-an-empty-body]]

**Size a test's time bound for a loaded machine.** A test that starts a freshly written executable gives it seconds, not the time it takes on an idle machine; only the case that must time out keeps a short bound.
Why: [[docs/lessons/a-freshly-written-executable-starts-slowly-under-load]]

**Search every string form.** A sweep for a pattern must match every way the code can spell it (quoted strings, template literals, concatenation), and a test must exercise the case where the forms differ.
Why: [template-literal absolute paths evade grep](https://github.com/lepsto/lepsto-mail-docs/blob/main/docs/lessons/fed-003-template-literal-absolute-paths-evade-grep.md)

## Before you call it done

**Check live the flows the old system never took.** A ported suite proves only the flows the old system used. List the uses your design makes ordinary that the old flow avoided (a launch without a prompt, a restart at an odd moment) and run each one live before you call the port done.
Why: [[docs/lessons/live-check-the-path-the-old-system-never-took]]

**Live-check the desktop app the way the human starts it.** A launch from a shell inherits the shell's locale and `PATH`; one launch of the packed app from Finder or `open` is part of every live check of the app.
Why: [[docs/lessons/check-the-desktop-app-as-the-human-starts-it]]

**Prove a start text on live agents of every harness.** Text written for a model is tested by what models do with it: run one small task with an agent of each harness that will read the text, and read each agent's own transcript for what it did and did not do. Tests of the wording prove only the wording.
Why: [[docs/lessons/a-start-text-is-proven-on-live-agents-of-every-harness]]

**Every check needs a case on which it must go red.** A check that only ever reports "clean" cannot be told apart from one that measures nothing. Keep the red case next to the check as a test. Never accept a proxy as evidence.
Why: [checks that are empty by construction](https://github.com/lepsto/lepsto-mail-docs/blob/main/docs/lessons/checks-that-are-empty-by-construction.md)

**Prove an async path by the state it changed, in the environment that owns the data.** A 200 from an ingest, a quiet log or a delivered message proves only its own hop; read the row the path should have written.
Why: [a shared configuration set routes feedback to the wrong environment](https://github.com/lepsto/lepsto-mail-docs/blob/main/docs/lessons/a-shared-configuration-set-routes-feedback-to-the-wrong-environment.md), [prove a schedule by state, not by silence](https://github.com/lepsto/lepsto-mail-docs/blob/main/docs/lessons/prove-a-schedule-by-state-not-by-silence.md)

**Check that a green test looks at the right screen.** A passing assertion over a component in its error state proves nothing.
Why: [a stub that answers everything hides the screen it broke](https://github.com/lepsto/lepsto-mail-docs/blob/main/docs/lessons/a-stub-that-answers-everything-hides-the-screen-it-broke.md)

**State what your evidence does not cover.** "The job cannot go green without running" is not "the job ran on this SHA".
Why: [staleness that does not announce itself](https://github.com/lepsto/lepsto-mail-docs/blob/main/docs/lessons/staleness-that-does-not-announce-itself.md)

**Keep a whole-branch review even when every per-task review was clean.** Patterns that span files are exactly what per-task scopes miss.
Why: [template-literal absolute paths evade grep](https://github.com/lepsto/lepsto-mail-docs/blob/main/docs/lessons/fed-003-template-literal-absolute-paths-evade-grep.md)

## Shipping it

**A green result expires when `main` moves.** Rebase onto the latest `origin/main` and re-run the full suite right before merge. A clean merge is not a passing test.
Why: [rebase and re-verify before merge](https://github.com/lepsto/lepsto-mail-docs/blob/main/docs/lessons/rebase-and-reverify-before-merge-main-moves-fast.md)

## Verify

- Each claim in your report names the artefact you read for it.
- Each new check has a test on which it goes red.
- The suite ran on a branch rebased on current `origin/main`.

## Related

- [[docs/playbooks/run-parallel-workers]] — rules for running several workers at once
- [[docs/playbooks/consolidate-lessons]] — how a lesson becomes a rule here or a fact in the tree
