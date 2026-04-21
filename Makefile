.PHONY: build run clean icon package install install-system reinstall open

build:
	swift build

run:
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
