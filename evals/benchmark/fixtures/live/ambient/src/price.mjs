/** An integer number of cents as an amount string. */
export function formatAmount(cents) {
  const digits = String(cents);
  const whole = digits.slice(0, -2) || '0';
  const fraction = digits.slice(-2);
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  return `${grouped},${fraction}`;
}
