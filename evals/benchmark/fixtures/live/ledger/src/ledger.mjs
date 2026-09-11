import { readFileSync } from 'node:fs';

const rates = JSON.parse(readFileSync('src/rates.json', 'utf8'));
const [code, amount] = process.argv.slice(2);
process.stdout.write((Number(amount) * rates[code]).toFixed(2) + ' USD\n');
