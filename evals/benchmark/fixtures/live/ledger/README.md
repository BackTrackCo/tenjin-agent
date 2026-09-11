# Fixture repository

A CLI that converts an amount in one of the currencies this deployment carries into US dollars, printed to two decimal places. The rates it converts against ship beside it, and the scheduler that calls the CLI names it by its full path and runs it from wherever the scheduler happens to be.
Run one test file with `pnpm test -- tests/<name>.test.mjs`; the cases it runs come from the runner, so a run is the only place to read them.
