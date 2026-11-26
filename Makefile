# Thin wrappers. CI runs the same commands.
.PHONY: help test check lint hooks eval

help: ## Show the targets
	@grep -hE '^[a-z][a-z-]+:.*##' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*## "}; {printf "  %-8s %s\n", $$1, $$2}'

test: ## Run the installer and import tests
	@node --test --test-global-setup=tests/tmpdir-setup.mjs 'tests/*.test.mjs'

check: ## Check the imported files against upstream/lock.json
	@node tools/upstream.mjs --check

lint: ## Check the shell scripts, privacy, the patrol copies and the STE prose
	@shellcheck tools/install tools/privacy.sh tools/hooks/pre-commit tools/hooks/pre-push
	@tools/privacy.sh index
	@cmp skills/patrol/scripts/patrol.mjs tools/patrol/patrol.mjs
	@cmp skills/patrol/playbook.md tools/patrol/playbook.md
	@cmp skills/patrol/prompts/scan.md tools/patrol/prompts/scan.md
	@npx --yes --package agent-ste@0.5.4 ste-lint rules/AGENTS.md AGENTS.md README.md THIRD_PARTY.md SECURITY.md skills/untangle/SKILL.md skills/tldr/SKILL.md skills/cleanup/SKILL.md skills/no-comments/SKILL.md skills/verify-pr/SKILL.md skills/verify-pr/references/blame.md skills/patrol/SKILL.md skills/featuremap/SKILL.md rules/output-style.md evals/README.md

hooks: ## Use the Git hooks of tools/hooks in this clone
	@git config core.hooksPath tools/hooks

eval: ## Run the skill evals with Claude Code and Codex (uses your plan)
	@node tools/eval.mjs $(ARGS)
