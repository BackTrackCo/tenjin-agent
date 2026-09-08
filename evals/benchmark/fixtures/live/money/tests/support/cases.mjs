import { gunzipSync } from 'node:zlib';

// The cases are frozen as a compressed blob. Run the test to learn them.
const BLOB =
  'H4sIAAAAAAAC/4uuVkosyc/NTFayUjA0NQABHQWl1IqC1OSS1BSgoJKhnqmBQmiwi7NSrY4CkmpTLGoN9AxMoWpjAawUA6BaAAAA';

export const cases = JSON.parse(gunzipSync(Buffer.from(BLOB, 'base64')).toString('utf8'));
