---
kind: leaf
up: [[docs/app/README]]
verified: 2026-11-17 — make app-test on github-repos (gh and GitHub faked with local bare repositories) and a live check
---

# Repositories from GitHub

A project's repositories can be picked from GitHub as well as given as folders. The app does the git work; the daemon still sees only folders.

1. A repository picked from GitHub is cloned by the app into `$HOPP_HOME/repos/<owner>__<repo>`, an ordinary clone, and the project keeps that path like any folder. The app works through the user's own `gh` CLI: hopp stores no token.
2. The list holds the repositories the user can access (their own, as a collaborator, as an organization member), most recently pushed first, and is kept for five minutes. When `gh` is missing or not logged in, the app says so and names the command that fixes it.
3. Adding a repository clones it only when it is not there; two adds at once share one clone, a clone that fails leaves no folder behind, and a folder in the way that is not a clone is refused rather than overwritten.
4. A task on a cloned repository fetches it first (for at most 60 seconds) and starts its worktree from the remote's default branch (`origin/<branch>`), not from the clone's own checkout. When the fetch fails or runs out, the task still starts from what was fetched last, and the reason is kept with the task and told to its orchestrator, so a start that may be behind GitHub is never silent; a repository without any commit refuses the task.
5. Cloned worker repositories are fetched at task start too, and the orchestrator's start text tells it to base worker worktrees on `origin/<branch>` after a fetch. A repository given as a folder keeps starting from its current HEAD.
6. Removing a project keeps its clones.

Code: [shell](app/src/main/shell), [shared](app/src/shared)
