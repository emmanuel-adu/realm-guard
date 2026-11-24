---
# realm-guard-brrg
title: 'Fresh-eyes review: six false clear verdicts and hardening'
status: completed
type: bug
created_at: 2026-11-24T02:57:16Z
updated_at: 2026-11-24T02:57:16Z
parent: realm-guard-5une
---

The adversarial review reached a false 'No boundary issues found' six ways: a disabled pass-through node, two credentials sharing a display name, nested agents, $('Node') references across branches, an approval whose answer nothing checks, and a misspelled manifest key. Also fixed: unrecognized QBO calls (credential type, template literals, tool placeholders), a YAML alias that blanked the page, Markdown report spoofing, a cubic-time approval search (49 s to under 1 s on 800 nodes), fixed memory keys written as expressions, local report dates, and a CSP that refuses every network request. 26 regression tests in test/review.test.ts.
