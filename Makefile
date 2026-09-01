.PHONY: build test runtime run clean icon package install install-system reinstall open

build:
	swift build

test:
	swift test
	node --test helper/helper-lib.test.mjs

runtime:
	./scripts/bootstrap-runtime.sh

run: runtime
	swift run

icon:
	./scripts/build-icon.sh

package:
	./scripts/package-app.sh

install:
	./scripts/install.sh

install-system:
	./scripts/install.sh --system

reinstall:
	./scripts/install.sh --open

open:
	open "dist/Word Fixer.app"

clean:
	swift package clean
	rm -rf dist
