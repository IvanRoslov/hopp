.PHONY: lint-docs test-lint build test

lint-docs:
	python3 scripts/lint_docs.py .

test-lint:
	cd scripts && python3 -m unittest discover -p 'test_*.py' -v

# codesign (macOS only): on Apple Silicon an unsigned or re-written binary is
# killed with SIGKILL, which looks like a silent exit 137. The Go linker's own
# ad-hoc signature breaks on any in-place edit; an explicit ad-hoc signature
# replaces it. Systems without codesign skip the step.
build:
	go build -o bin/hopp ./cmd/hopp
	@if [ "$$(uname -s)" = Darwin ] && command -v codesign >/dev/null 2>&1; then codesign --force --sign - bin/hopp; fi

test:
	go test ./...
