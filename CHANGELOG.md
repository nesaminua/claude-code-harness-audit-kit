# Changelog

## 1.0.0 — 2026-11-25

First public release.

- Daily audit of Claude Code transcripts, triggered by the first session of the day (no cron, no daemon).
- 8 detectors: hook block loops, overrides added right after a block, verbatim retries after a block, repeated tool errors, user corrections (EN, RU, UK, ES, DE, PT, FR), interrupts, hook crashes/errors/timeouts, and user-defined forbidden patterns.
- Fix queue with dedupe per session and day, reopen on recurrence after a fix, dismiss latch, expiry.
- Next-day fix order injected into the first session, plus `rules/harness-audit.md` telling Claude how to work it.
- Fix efficacy: per-key before/after rate over up to 7 audited days, with `insufficient` and `pending` verdicts instead of guessing.
- Redaction of tokens, keys, e-mails and home paths in everything the kit writes.
- Optional haiku judge, off by default.
- Installer for macOS, Linux and Windows; honours `CLAUDE_CONFIG_DIR`.
