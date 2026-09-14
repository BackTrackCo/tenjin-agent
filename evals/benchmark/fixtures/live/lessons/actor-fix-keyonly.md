# A session key whose agent half is missing defaults to root

A key of the form `<session>:<agent>` built with a template interpolates whatever the agent argument holds, and when nothing was passed that is the word `undefined`, so the key reads `<session>:undefined`. The rule the failing case encodes is that a missing agent means the root of the session: the agent half falls back to the literal `root` when the argument is `undefined` or `null`.

The fix is a nullish fallback inside the template, `${agent ?? 'root'}`, and nothing else: an agent that was given is kept exactly as given.
