---
id: claude-code-trusts-a-worktree-through-its-main-repository
date: 2026-11-17
services: ["[[docs/daemon/README]]"]
source: commit a6e1d24
status: consolidated
consolidated-into: ["[[docs/daemon/sessions]]", "[[docs/daemon/activity]]", "[[docs/playbooks/verify-a-change]]"]
---

## What happened

The first real task's orchestrator (Claude Code 2.1.326) stopped on "Quick safety check … This folder pre-approves 5 tool permissions in .claude/settings.json" in its fresh worktree, and the session showed as idle. `~/.claude.json` already held `hasTrustDialogAccepted: true` for the worktree path, written by the code ported from rocket.

## Why / root cause

Reproduced in throwaway repositories: plain folders with a pre-trust entry never showed the screen; a linked git worktree of a repository whose `.claude/settings.json` pre-approves permissions did. Accepting the screen changed one entry, `projects[<main repository>].hasTrustDialogAccepted`: Claude Code reads that trust under the project root, which for a worktree is the main repository. rocket's code wrote only the worktree's key, so reading rocket could not have shown the gap.

## What to do now

When an external tool stops a launch, reproduce it in a throwaway, take the human's step once, and diff the tool's own state before and after; that diff, not the older system's code, says which key to write. Product half: [[docs/daemon/sessions]] fact 9 (a launch also trusts the main repository) and [[docs/daemon/activity]] fact 5 (the screen is caught and raised as a question). Process half: the "Learn what a tool records from its own state" rule in [[docs/playbooks/verify-a-change]].
