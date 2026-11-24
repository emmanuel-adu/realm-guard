---
# realm-guard-fra7
title: HTTP calls with a QuickBooks credential but a hidden URL were missed
status: completed
type: bug
created_at: 2026-11-24T02:03:19Z
updated_at: 2026-11-24T02:03:19Z
parent: realm-guard-5une
---

Found by the robustness run over 2,066 public exports: URLs behind $env variables hid QBO calls. Now the attached quickBooksOAuth2Api credential marks the node, and the unreadable company ID is a coverage gap. Regression test in scan.test.ts.
