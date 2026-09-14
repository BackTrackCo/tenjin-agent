import assert from 'node:assert/strict';
import { actorKey } from '../src/actor.mjs';
assert.equal(actorKey('s9', undefined), 's9:root');
assert.equal(actorKey('s9', 'b2'), 's9:b2');
