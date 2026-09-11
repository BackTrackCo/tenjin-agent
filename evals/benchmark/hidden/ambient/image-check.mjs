// The quirk this task's difficulty rests on, asserted against the image that
// will run it. `ambient` hides one byte of one library's output: the group
// separator ICU emits for this locale is U+00A0, not the ordinary space a
// hand-written implementation types. A base-image bump that moves ICU (72
// moved several locales to U+202F) would turn a hard task into a trivial one
// and nothing else would say so, so the build refuses the image instead.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const NBSP = '\u00a0';
const SPACE = '\u0020';
const cases = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'cases.json'), 'utf8'),
);
const format = new Intl.NumberFormat('sv-SE', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

let grouped = 0;
for (const { args, expected } of cases) {
  assert.equal(
    format.format(args[0] / 100),
    expected,
    `Intl no longer renders ${args[0]} as the frozen case`,
  );
  assert.ok(
    !expected.includes(SPACE),
    'an expected value carries U+0020, so its mismatch would be visible',
  );
  if (expected.includes(NBSP)) grouped += 1;
}
assert.ok(grouped >= 2, 'no expected value carries U+00A0: this image no longer hides anything');
process.stdout.write(
  `ambient: ICU ${process.versions.icu} on ${process.version} groups with U+00A0 in ${grouped} of ${cases.length} cases\n`,
);
