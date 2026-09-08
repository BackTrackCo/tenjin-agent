import { gunzipSync } from 'node:zlib';

// The cases are frozen as a compressed blob. Run the test to learn them.
const BLOB =
  'H4sIAAAAAAAC/4uuVkosSi9WslKIjjbUUTDSUTDWUTDRUTCNBXKAWCm1oiA1uSQ1BaQCLF6ro4CmJxaiHEUpWBxVqbmOgoWOgiVQpQG66tjaWAAFqsMJiQAAAA==';

export const cases = JSON.parse(gunzipSync(Buffer.from(BLOB, 'base64')).toString('utf8'));
