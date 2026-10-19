.PHONY: help install test dev deploy plugin-test widget widget-stop icons

WIDGET_BIN := widget/target/debug/cession-widget

help: ## List targets
	@grep -E '^[a-z-]+:.*## ' $(MAKEFILE_LIST) | awk -F':.*## ' '{printf "  %-12s %s\n", $$1, $$2}'

install: ## Install server dependencies
	cd server && npm install

test: ## Server tests + typecheck, widget tests
	cd server && npm test && npm run typecheck
	cd widget && cargo test

dev: ## Run the Worker locally on :8787
	cd server && npm run dev

deploy: test ## Test, then deploy the Worker
	cd server && npm run deploy

plugin-test: ## End-to-end hook test; needs `make dev` running
	sh plugin/test.sh

widget: ## Build and (re)launch the macOS widget in the background
	cd widget && cargo build
	-pkill -x cession-widget
	nohup $(WIDGET_BIN) > $${TMPDIR:-/tmp}/cession-widget.log 2>&1 &

widget-stop: ## Quit the widget
	-pkill -x cession-widget

icons: ## Re-render widget PNGs from the SVG sources
	rsvg-convert -w 512 -h 512 widget/icons/icon.svg -o widget/icons/icon.png
	rsvg-convert -w 44 -h 44 widget/icons/tray.svg -o widget/icons/tray.png
