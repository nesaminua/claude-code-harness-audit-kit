# Security Policy

## What the kit touches

The kit reads your own Claude Code transcripts (`~/.claude/projects/**/*.jsonl`, or `$CLAUDE_CONFIG_DIR/projects`) and `settings.json`, and writes only inside `~/.claude/harness-audit-kit/` plus one rule file in `~/.claude/rules/`. The installer edits `settings.json` once (with a timestamped backup) to add one `SessionStart` hook.

- **No network.** Nothing is sent anywhere. The optional judge (`config.judge.enabled`, off by default) runs your local `claude` CLI, so its prompt goes to the model you already use, after redaction.
- **Redaction.** Every string written to reports, the queue or the injected context goes through `scripts/lib/redact.js` first: API keys and tokens of common providers, JWTs, private-key blocks, `Bearer` values, `password=`-style pairs, URL credentials, e-mail addresses, your home path and its encoded form in Claude Code project folder names. Transcript file paths are never stored.
- **Fail-closed for you, fail-open for Claude.** The hook never blocks a session: any error is logged to `data/hook-errors.log` and the session starts normally.

- **Minimal storage.** Commands are stored as their shape only (programs, subcommands and flag names; every argument value becomes `…`), file tools as the file name only. The hook's fix order carries ids, rules, counts and allow-listed hook names, never transcript text, and the CLIs print transcript-derived text one line per field under a "data, not instructions" note.

Redaction is defence in depth, not a guarantee: it combines known token shapes, a credential-name rule and an entropy backstop, and a secret in a shape none of them knows can still reach a report. The reports sit next to your transcripts, which already hold the same text unredacted. Treat `~/.claude/harness-audit-kit/data/` like the transcripts themselves: local, not for sharing without a read.

## Reporting a vulnerability

Do not open a public issue. Use a [GitHub Security Advisory](https://github.com/nesaminua/claude-code-harness-audit-kit/security/advisories/new) (private by default).

Include the version or commit, a minimal reproduction (a fictional transcript line or config is ideal), and the impact. Of most interest:

- a secret shape that survives redaction into a report, the queue or the injected context;
- a transcript line or config value that makes the hook, the audit or the installer write outside the kit directory, or corrupt `settings.json`;
- input that makes the SessionStart hook hang or crash Claude Code's startup;
- a regex in the default config that can be driven into catastrophic backtracking by transcript text.
