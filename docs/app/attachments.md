---
kind: leaf
up: [[docs/app/README]]
verified: 2026-11-18 — against the code of branch attachments (from main be30b99): shared/attachments.ts, ui/Attachments.tsx, NewTask, Feed, main/attachments.ts and main/shell/attachments.ts; make app-test there; the clipboard formats read through Electron 45.3.3
---

# Attaching files and folders

How the human gives an agent files and folders: in the New task brief and in a line of a task's feed, the same way in both.

1. The New task brief and the line in a task's feed take files and folders three ways: the clip button (the system dialog, files and folders, several at once), dropping them on the field, and pasting. Nothing is copied: an attachment is its absolute path, and the agent reads it there.
2. A paste of files or folders copied in Finder attaches their paths and leaves out the names Finder puts beside them as text. An image on the clipboard that is not a file, such as a screenshot taken to the clipboard, is saved as `<app home>/attachments/pasted-<time>-<random>.png` and attached; the app never deletes these files. Any other paste goes in as text, as before.
3. Before sending, each attachment is a chip under the field: its name, the full path in the tooltip, a folder icon for a folder, a small preview for an image file, and a cross that removes it. A path already attached is not added again.
4. Sending checks every path first: one that is gone stops the send and is named beside the chips.
5. On send the paths go at the end of the text as one block, a line `Attached:` and then `- <absolute path>` per attachment, a folder ending with `/`; attachments alone may be sent. In New task the block is part of the brief, so it reaches the orchestrator's start text and first message, and a brief of attachments only names the task after the first one; in the feed it is part of the message, or of the answer. The daemon sees only text.
6. In the feed, the Attached block of what the human wrote (the brief, their lines, their answers) shows as chips: a click opens the path in its app (a folder in Finder), ⌘-click shows it in Finder. An agent's post shows as written.

Code: [attachments in the page](app/src/renderer/ui), [main process](app/src/main), [shared](app/src/shared)
