import { correction, generate } from 'lean-qr';
import { getAddress, isAddress } from 'viem';

/** The line under the code: what to send and on which chain, in CAIP-2 form. */
export const QR_NETWORK_LINE = 'USDC on Base (eip155:8453)';

/** Modules of light margin drawn around the code: the QR spec's minimum. */
const QUIET_ZONE = 4;
/**
 * Black on white from the 256-color cube (16 is #000000, 231 is #ffffff), set
 * explicitly so the code scans the same way on a dark or a light theme. The
 * 16-color slots (`30;47`) follow the theme's palette, and light themes such as
 * VS Code's map "white" to a mid grey, too dark against black to scan.
 */
const DARK_ON_LIGHT = '\x1b[38;5;16;48;5;231m';
const RESET = '\x1b[0m';

/** What the QR renderer reads off the target stream; a real `tty.WriteStream` has both. */
interface TerminalFacts {
  columns?: unknown;
  hasColors?: unknown;
}

/**
 * The QR block for a wallet address: the code drawn two module rows per line with
 * half blocks, then {@link QR_NETWORK_LINE}. It encodes the plain EIP-55 address,
 * which is what a phone wallet's send scanner accepts. Returns [] when the code
 * cannot be drawn correctly on `stream`: the address is not an EVM address, the
 * stream reports no width or is narrower than the code, or it cannot show 256
 * colors (not a TTY, NO_COLOR, TERM=dumb, a 16-color terminal). The caller still
 * prints the address as text. Without the forced colors a dark theme would draw
 * the code inverted, which many scanners reject.
 */
export function addressQrLines(address: string, stream: NodeJS.WritableStream): string[] {
  if (!isAddress(address, { strict: false })) return [];
  const facts = stream as TerminalFacts;
  if (typeof facts.hasColors !== 'function') return [];
  if (facts.hasColors.call(stream, 256) !== true) return [];
  const code = generate(getAddress(address), {
    minCorrectionLevel: correction.M,
    maxCorrectionLevel: correction.M,
  });
  const span = code.size + 2 * QUIET_ZONE;
  if (typeof facts.columns !== 'number' || facts.columns < span) return [];

  const dark = (x: number, y: number): boolean =>
    x >= 0 && y >= 0 && x < code.size && y < code.size && code.get(x, y);
  const lines: string[] = [];
  for (let y = -QUIET_ZONE; y < code.size + QUIET_ZONE; y += 2) {
    let line = '';
    for (let x = -QUIET_ZONE; x < code.size + QUIET_ZONE; x++) {
      const top = dark(x, y);
      const bottom = dark(x, y + 1);
      line += top && bottom ? '█' : top ? '▀' : bottom ? '▄' : ' ';
    }
    lines.push(`${DARK_ON_LIGHT}${line}${RESET}`);
  }
  lines.push(QR_NETWORK_LINE);
  return lines;
}
