.PHONY: lint-docs test-lint build test start stop restart status

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

start: build
	bin/hopp daemon start
	bin/hopp daemon status

stop:
	bin/hopp daemon stop 2>/dev/null || { [ -x bin/hopp ] || go build -o bin/hopp ./cmd/hopp; bin/hopp daemon stop; }

# Build first, then stop and start: stopping before the build would leave a
# window in which any CLI call autostarts the OLD binary.
restart: build
	bin/hopp daemon stop
	bin/hopp daemon start
	bin/hopp daemon status

status:
	bin/hopp daemon status
