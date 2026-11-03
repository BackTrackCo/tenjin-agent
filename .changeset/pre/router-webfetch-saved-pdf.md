---
'tenjin-cli': patch
---

A PDF that WebFetch fetched is now pointed at for free. WebFetch's summary is
handed the PDF's compressed bytes and says it cannot parse them (arxiv.org's
"Attention Is All You Need" came back as "a corrupted or binary PDF file"), but
Claude Code saves the file whole and names it on the result's last line. The
after-call hook now adds one line naming that file and saying `Read` returns its
text, and asks the router nothing: a paid page reader would only fetch the same
file again. Only a file named the way WebFetch names one, on that last line, in
the session's own tool-results directory, is ever pointed at.
