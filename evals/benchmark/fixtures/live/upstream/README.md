# Fixture repository

`summarize(csv)` reads a stock export and reports two figures: `lines`, how many stock lines the export holds, and `units`, what their quantities add up to. Quantities are whole numbers and a line may leave one blank.
Run one test file with `pnpm test -- tests/<name>.test.mjs`; the cases it runs come from the runner, so a run is the only place to read them.
