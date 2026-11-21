// Lets `node --experimental-strip-types --import ./register.mjs file.ts` run the repo's TypeScript,
// whose imports carry no extension. Test helpers only.
import { register } from 'node:module';

register('./resolve.mjs', import.meta.url);
