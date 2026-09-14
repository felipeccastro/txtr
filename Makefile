PORT := 8777

.PHONY: run
run:
	python3 -m http.server $(PORT)

.DEFAULT_GOAL := run
