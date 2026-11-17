---
kind: leaf
up: [[docs/app/shell]]
verified: 2026-11-17 — make app-test on the models branch, including a run against the real daemon on a temp HOPP_HOME
---

# Model profiles in the app

The app edits the daemon's model profiles; it keeps no copy of them.

1. Settings → Models switches a profile on and off, edits its description, model and effort (the daemon checks the model and effort against the harness), makes a profile the default and changes the order, all through the daemon's API.
2. The default profile cannot be switched off: another profile has to become the default first. A profile that a running session or an active task uses cannot be removed; switching it off is the way to stop offering it.
3. The catalog shows what each harness offers, marks the models that already have a profile, and says when a harness's list could not be read.
4. Import adds one profile for every current model that has none, switched off and named as rocket named them; it never changes an existing profile, keeps the profiles of models that disappeared, goes on when one harness fails, and adds nothing when run again.
5. The new task form offers only switched-on profiles. A change made in the app refreshes open forms at once; a change made with `hopp models` shows on their next load.

Code: [shell](app/src/main/shell), [shared](app/src/shared)
