import assert from 'node:assert/strict';
import { actorKey } from '../src/actor.mjs';
assert.equal(actorKey('s1', undefined), 's1:root');
