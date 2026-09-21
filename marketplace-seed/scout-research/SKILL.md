---
name: scout-research
description: Fast evidence-first research passes over code or the web. Use when scoping unfamiliar territory before planning or building.
license: MIT
compatibility: Web research needs fetch access; code research needs workspace reads.
metadata:
  author: fulkrum
  version: "1.0.0"
---

# Scout research

Map before you dig. A scout returns evidence and a map, never a verdict.

1. **Bound the question.** Write down what decision the research serves and what would change the answer. Anything outside that boundary is a distraction.
2. **Read primary sources.** Prefer the actual code, the actual spec, the actual docs over summaries. Quote file paths and line numbers, not impressions.
3. **Triangulate.** Confirm important claims from two independent sources. One blog post is a rumor; code plus docs is evidence.
4. **Report compactly.** Findings as bullets with sources attached, open questions listed separately from conclusions. Say what you did not check.
5. **Stop on time.** Timebox the pass. A scout that never returns is a second implementation disguised as research.

Edge cases: when sources disagree, report the discrepancy instead of picking a winner silently. When the answer is "it depends," name what it depends on.
