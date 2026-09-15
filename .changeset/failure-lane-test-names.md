---
'tenjin-cli': minor
---

The failure arm keys a test failure by the test's name, reads it from the command's own output, and no longer fingerprints rendered error text (tenjin-agent#350).

**The vitest reporter prints a line instead of writing a file.** After vitest's summary it prints one GitHub Actions line per failed test, `::error title=<file> > <suite> > <test>::<Name>: <first message line>`, at most the last ten. It is the last thing the run prints, so an agent's `2>&1 | tail` keeps it even when the pipe cut the assertion above. `.vitest-report.json` is gone, and so is everything that found, dated and owned it: the config scan, the per-call `bashstart` stamp and the single-segment rule, which between them read the file for none of 1,004 real vitest failures on one machine.

**Keys are test names.** Round one sends `test:<file> > <suite> > <test>` for every test the output names, at most ten: from the reporter's lines, or from vitest's `FAIL` header with the project label (`|node|`) taken off, so both give the same bytes. `sig_v1` and `sig_v1_test` are gone. Pieces published under them no longer match by key; they are still reachable in words.

**The error line is picked one line at a time.** The last line carrying an error marker that is not a totals row, a stack frame or a code-frame gutter, preferring anything to a wrapper's verdict. It replaces the block walker, which read vitest's `❯` stack pointers as block headers and returned nothing for most vitest failures, and which picked pnpm's `ELIFECYCLE … exit code 2` over tsc's own `error TS…` line.

**Round two asks the error line with the failing test's name beside it.**

**What leaves the machine changes.** The names of failing tests and their file paths now go to the team shelf as the runner printed them, where a hash went before. The error line goes as before, masked. No command timestamp is kept.

**The turn-end ask quotes each `--key`**, so a test name with spaces, `>` or quotes pastes as one flag.
