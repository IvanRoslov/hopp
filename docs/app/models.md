---
kind: leaf
up: [[docs/app/README]]
verified: 2026-11-17 — against the code on main (e9468d7): the model-profile calls of service.ts, shared/profileNames.ts, Models.tsx and ModelProfileForm.tsx; make app-test there
---

# Model profiles in the app

The app edits the daemon's model profiles; it keeps no copy of them.

1. Settings → Models switches a profile on and off, edits its description and effort, makes a profile the default and changes the order, all through the daemon's API, which checks the effort against the model.
2. The default profile cannot be switched off: another profile has to become the default first. A profile that a running session or an active task uses cannot be removed; switching it off is the way to stop offering it.
3. The catalog shows what each harness offers, marks the models that already have a profile, and says when a harness's list could not be read.
4. Import adds one profile for every current model that has none, switched off and named as rocket named them; it never changes an existing profile, keeps the profiles of models that disappeared, goes on when one harness fails, and adds nothing when run again.
5. Add model makes a profile of any harness for a model of its catalog or any model id the catalog does not list (the daemon does not check model ids), with the model's levels as efforts, or the harness's levels for an unlisted id; Copy… makes one with the same harness and model at another effort. A profile the human makes is switched on.
6. A profile made without a name is named as an import would name its model, with the effort as a suffix (`kimi-k3-1-pro-max`); a copy takes its source's name with the new effort in place of the old one, or `-copy` when the effort stays, and `-2`, `-3`, … make a taken name free.
7. The New task and New agent forms offer only switched-on profiles. A change made in the app refreshes open forms at once; one made with `hopp models` shows when the window comes back to the front or the form is opened again.

Code: [shell](app/src/main/shell), [shared](app/src/shared)
