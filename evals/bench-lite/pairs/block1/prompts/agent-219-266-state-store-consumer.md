# Let real repository work activate the first capture ask

The team-shelf capture ask at the end of a session currently fires only off a small set of
signals, and it misses the most common case worth asking about: a session where the agent
actually worked in the repository. Record that it happened. Recognise exactly three classes of
root-agent repository work, inspection, mutation and shell work, and mark each one at most
once per session so repeated tool calls refresh a fixed, tiny number of marks rather than
growing with activity.

The marks must be content-free. No command line, no path, no tool output, no counter: the mark
exists only so the Stop ask can tell a working session from an untouched one, and nothing
operator-controlled may be copied into stored state. Writing one requires a real session, a
root agent rather than a subagent, and a project working directory; a session that has already
been asked must not acquire new marks, so answering an ask can never re-arm one.

Let the presence of any such mark activate the first team-shelf capture ask, without widening
what the public marketplace path asks about. Preserve the existing background-agent deferral,
the once-per-session behaviour and the no-re-arm rule. Publishing or editing Tenjin content is
the capture loop's own disposition, not repository work, so exclude those shell commands
including the supported global-option spellings that reach the same leaf command. Work within
`src/`, do not change the answer-card or search contracts, and run only the focused test files
you touch.
