.PHONY: lint-docs test-lint build test install start stop restart status app-install app-dev app-test app-build app-pack app-install-mac

lint-docs:
	python3 scripts/lint_docs.py .

test-lint:
	cd scripts && python3 -m unittest discover -p 'test_*.py' -v

# Go: the module lives in daemon/ (go.mod, cmd/, internal/), while its module
# path stays github.com/IvanRoslov/hopp; the directory name and the module
# path differ on purpose. Go commands run inside daemon/, and the program is
# still built to bin/hopp at the repository root.
#
# codesign (macOS only): on Apple Silicon an unsigned or re-written binary is
# killed with SIGKILL, which looks like a silent exit 137. The Go linker's own
# ad-hoc signature breaks on any in-place edit; an explicit ad-hoc signature
# replaces it. Systems without codesign skip the step.
build:
	cd daemon && go build -o ../bin/hopp ./cmd/hopp
	@if [ "$$(uname -s)" = Darwin ] && command -v codesign >/dev/null 2>&1; then codesign --force --sign - bin/hopp; fi

test:
	cd daemon && go test ./...

# The global `hopp` command: a symlink to bin/hopp, so every `make build`
# updates it. It must be a symlink, not a copy. Replacing an installed binary
# with `cp` writes into the same inode: a process already running from it no
# longer matches its code signature, and the kernel kills it with SIGKILL
# (exit 137); a new launch dies the same silent way. If a copy is ever needed,
# `cp` to a temporary file next to it and `mv` it over (an atomic rename
# changes the inode), or run `codesign --force --sign -` after the cp.
install: build
	ln -sf $(CURDIR)/bin/hopp /opt/homebrew/bin/hopp

start: build
	bin/hopp daemon start
	bin/hopp daemon status

stop:
	bin/hopp daemon stop 2>/dev/null || { [ -x bin/hopp ] || (cd daemon && go build -o ../bin/hopp ./cmd/hopp); bin/hopp daemon stop; }

# Build first, then stop and start: stopping before the build would leave a
# window in which any CLI call autostarts the OLD binary.
restart: build
	bin/hopp daemon stop
	bin/hopp daemon start
	bin/hopp daemon status

status:
	bin/hopp daemon status

# The desktop app (app/): Electron + React + TypeScript. Its tests run against a
# fake daemon on a temporary socket and never touch ~/.hopp.
app-install:
	cd app && npm ci

app-dev:
	cd app && npm run dev

app-test:
	cd app && npm run typecheck && npm test && npm run test:e2e

app-build:
	cd app && npm run build

# An unsigned macOS bundle for this machine (arm64): app/dist/hopp-darwin-arm64/hopp.app.
# Not signed or notarized; nothing is installed or copied to /Applications.
app-pack:
	cd app && npm run build && node scripts/pack.mjs

# Builds the bundle and puts it in /Applications/hopp.app, replacing the copy
# there. A running hopp.app is asked to quit first; the daemon is not touched.
app-install-mac: app-pack
	-test -d /Applications/hopp.app && pgrep -f /Applications/hopp.app/Contents/MacOS >/dev/null && osascript -e 'tell application "/Applications/hopp.app" to quit' && sleep 2
	rm -rf /Applications/hopp.app
	ditto app/dist/hopp-darwin-arm64/hopp.app /Applications/hopp.app
	@echo "installed /Applications/hopp.app"
