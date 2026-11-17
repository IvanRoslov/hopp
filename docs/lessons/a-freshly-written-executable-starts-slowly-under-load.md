---
id: a-freshly-written-executable-starts-slowly-under-load
date: 2026-11-17
services: ["[[docs/app/README]]"]
source: commit a2ce6fe
status: consolidated
consolidated-into: ["[[docs/app/connection]]", "[[docs/playbooks/verify-a-change]]"]
---

## What happened

A unit test of the login-shell `PATH` reader failed now and then. It wrote a fake shell script and gave it 2 seconds to answer; run beside other suites, 15 of 60 such starts ran out (measured).

## Why / root cause

On macOS a script written a moment ago can take seconds to start on a loaded machine. The bound the test used was far below the product's own (30 seconds), so the test measured the machine, not the code.

## What to do now

A test that starts a freshly written executable gets a bound sized for a loaded machine (the test now uses 15 seconds); only the case that must time out keeps a short bound. Product half: [[docs/app/connection]] fact 4 (the app waits up to 30 seconds for the login shell). Process half: the "Size a test's time bound for a loaded machine" rule in [[docs/playbooks/verify-a-change]].
