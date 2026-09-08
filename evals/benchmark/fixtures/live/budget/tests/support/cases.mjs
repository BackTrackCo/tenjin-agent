import { gunzipSync } from 'node:zlib';

// The cases are frozen as a compressed blob. Run the test to learn them.
const BLOB =
  'H4sIAAAAAAAAE4uuVkosSi9WsopWsjQwUIrVUUqtKEhNLklNUbICCtTqIOSNTNEVgESQVRgbYVURCwDvSxQAZQAAAA==';

export const cases = JSON.parse(gunzipSync(Buffer.from(BLOB, 'base64')).toString('utf8'));
