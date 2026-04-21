.PHONY: build run clean package install install-system open

build:
	swift build

run:
	swift run

package:
	./scripts/package-app.sh

install:
	./scripts/install.sh

install-system:
	./scripts/install.sh --system

open:
	open "dist/Word Fixer.app"

clean:
	swift package clean
	rm -rf dist
