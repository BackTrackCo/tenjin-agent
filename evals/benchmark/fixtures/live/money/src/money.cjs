'use strict';
Object.defineProperty(exports, '__esModule', { value: true });
function formatMoney(atomic) {
  return (Number(atomic) / 1e6).toFixed(2) + ' USDC';
}
exports.default = formatMoney;
