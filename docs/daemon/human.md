---
kind: leaf
up: [[docs/daemon/README]]
verified: 2026-11-17 — against the code on main (670ba12): api/asks.go (answers without a choice, POST /v1/asks/{id}/dismiss and its message), store/asks.go, session/quiz.go (answerSettle 400 ms), the Claude Code and Codex chat readers
---

# What the human sees and decides

The human reads what an agent said, answers the question an agent's screen waits on, and decides what agents ask. This leaf says what each of those shows and how an answer gets back.

### The chat feed

1. `hopp chat <id>` shows a session's conversation read from the agent's own journal (user and assistant turns, tool calls as one-line digests), plus the Claude Code permission dialogs hopp saw resolved; `--follow` keeps reading it. A session with no journal yet shows an empty feed, not an error.
2. The feed shows only what the agent writes into its journal, so a start screen, the pane's other text and a draft in the composer never appear in it. For Codex both journal shapes are read: the older one, and the one Codex 0.160 and later write; a turn written in both shows once.
3. For Claude Code and DeepSeek the feed reads the newest journal in the folder's Claude Code project directory, not the journal hopp bound at launch, so another Claude Code conversation written later in the same folder shows instead.

### Answering an agent's screen

4. hopp can answer four kinds of question an agent's screen waits on: a Claude Code permission dialog, a Claude Code question to the user (`AskUserQuestion`), and the start screens of Codex, Kimi Code and Claude Code (its folder-trust screen; Esc, which exits Claude Code, is not offered). `hopp answer <id>` shows the question, `hopp answer <id> <choice>` answers it, and the session JSON carries it as `question`. An `AskUserQuestion` question reaches hopp through its own hook. A permission dialog is looked for once the session reports that it waits on the human (`waiting_input`, from Claude Code's Notification hook), in every harness that runs Claude Code (Claude Code and DeepSeek).
5. Right before pressing a key, hopp captures the pane twice, 400 ms apart, because Claude Code redraws a moment after a key; when either capture no longer shows the same dialog, start screen or `AskUserQuestion` widget (a human answered in the terminal, or it closed), nothing is sent and the answer is refused with `prompt_changed`. A human's key that lands after the second capture can still cross hopp's; the stray key then sits in the agent's composer, unsent. An answer while another one is still being typed is refused with `quiz_answer_in_flight`, and one to a session with no question with `no_pending_quiz`.

### Decision requests

6. A session asks the human with `hopp ask "<text>"` (or the question from `--file <path>`, or stdin with `-`; a blank question is refused): one stored request with optional choices (`--option`), labels and attachments, which stays `open` until it is answered or withdrawn. An ask keeps the labels its session had when it was asked, overlaid with any `--label` given, so `hopp asks --label k=v` finds a session's asks by the session's labels; the daemon stores and filters the labels but never acts on them.
7. The human answers with `hopp reply <ask-id> [<choice>] [-m <text>]`, the choice by its number or its exact text; a choice may carry text too, such as what to fix with a "Return", and both are stored and sent. When no option fits, the text alone is the answer, with no choice. `hopp asks --all --label k=v` lists answered and withdrawn asks as well, so their history can be rebuilt. An ask is answered at most once: of two answers only the first is taken, and a later one is refused with `ask_closed`.
8. The answer returns to the asker twice: `hopp ask --wait` prints it, and the asking session gets one `[hopp] Answer to ask #<id>: …` system message, or its mailbox holds it while the session is not running. An asker that has ended with no mailbox gets nothing; the answer stays on the ask.
9. When the asking session ends, its open asks become `withdrawn` with reason `session_ended`, so nobody answers a question that can no longer be received. The asker may also withdraw an ask itself, and the human may close one that is no longer relevant with `hopp asks dismiss <id>`: it becomes `withdrawn` with reason `dismissed`, and the asker gets one `[hopp] Ask #<id> was dismissed …` message telling it not to wait for an answer.
10. `hopp waiting` is the one list of everything that waits for the human: the open asks and the questions sessions' screens wait on, each with the command that answers it.
11. There is no mailbox for the human. A message is for a session or a session's mailbox; an agent that needs the human uses `hopp ask`.

Code: [api](daemon/internal/api), [cli](daemon/internal/cli), [session](daemon/internal/session), [store](daemon/internal/store), [agent](daemon/internal/agent)
