import Papa from 'papaparse';

/** A stock export as its line count and the units those lines add up to. */
export function summarize(csv) {
  const { data } = Papa.parse(csv, { header: true });
  let units = 0;
  for (const row of data) units += Number(row.qty) || 0;
  return { lines: data.length, units };
}
