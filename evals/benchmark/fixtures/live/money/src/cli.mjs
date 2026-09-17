import formatMoney from './money.cjs';

process.stdout.write(formatMoney(process.argv[2]) + '\n');
