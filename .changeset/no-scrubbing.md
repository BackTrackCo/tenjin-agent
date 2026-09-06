---
'tenjin-cli': minor
---

No scrubbing: an agent's question is now exactly what it typed, with its secrets
masked, and nothing else (PR C2 of the loop redesign). Every hook's text goes
through `mask` and then the search leg's cut at the shelf's 512 characters on a
word boundary. That is the whole list. A prompt is not condensed, a url is not
split into words, a file name is not turned into a phrase, and no arm invents a
question out of something it read.

**What an agent sees differently.** Your prompt travels as the sentence you
typed, so the shelf ranks on your words rather than on this machine's summary of
them — condensing dropped stopwords and short clauses, and a summary is a
different question. The two length skips are gone with it: a 78-character
question is a question and gets asked, and a 5,000-character paste is asked
about too, cut at 512 like everything else. Three prompt skips remain, each its
own reason on the row: `slash` (a harness command), `words` (fewer than three
words of three characters once masked), and a new `harness` for text the tooling
sent through the prompt channel — `<task-notification>`, `<agent-message`,
`[SYSTEM NOTIFICATION`. A `WebFetch` now asks about the page's address and the
prompt attached to it, both as written; only the query string is dropped,
because a signed url keeps its credential in a parameter value whose shape
masking has no rule for. The `identifiers` list is no longer sent beside the
query at all: the shelf lifts identifiers out of the query itself, so sending a
second, client-computed copy only added a way for the two to disagree.

**The read and churn lookups are deleted.** Reading a source file no longer
asks the shelf about a package it imports, and the fourth edit of one file no
longer asks about the file. Both invented a question out of a file rather than
carrying one an agent asked, and neither ever produced the precision number that
was the reason to keep them log-only. `trigger` on the wire is now `prompt` or
`research`, and `read` and `churn` are gone from it.

**The context arm stays, and only writes marks.** It is registered on the same
events and still stamps what other arms read: a `Bash` call's start time
(`bashstart`), every edited path (`edited:`), and the lead's own inspection and
mutation activity (`activity:`). It asks nothing, so every fire on it is
recorded with the reason `no-question` — which is the truth, not a silent exit.
The per-file edit counter that fed the fourth-edit trigger is gone with the
trigger.

Owner decision, 2026-09-06: minimal alteration of what leaves the machine. A
transform that is not masking is a guess about what the agent meant, and a guess
this side makes is one the shelf never gets to see past.
