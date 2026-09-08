import { gunzipSync } from 'node:zlib';

// The cases are frozen as a compressed blob. Run the test to learn them.
const BLOB =
  'H4sIAAAAAAAAE4uuVkosSi9WsopWUnBKTM4OKQISzvn6Ial5WZl5eumZJQpKsTpKqRUFqcklqSlKVkpJQAUlIFXJ+folYFVKtToIUxKTc1P1yzNT0lNLitF0okjVxgIAHLE49HsAAAA=';

export const cases = JSON.parse(gunzipSync(Buffer.from(BLOB, 'base64')).toString('utf8'));
