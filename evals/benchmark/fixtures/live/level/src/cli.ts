import { levelOf } from './level.ts';

process.stdout.write(levelOf(Number(process.argv[2])) + '\n');
