import { describe, it, expect } from 'vitest';
import { correction, generate } from 'lean-qr';
import { getAddress } from 'viem';
import { addressQrLines, QR_NETWORK_LINE } from './qr';

const ADDRESS = getAddress('0x5c6e1b0f9a3a7bd2e8f4c1a9b0d3e6f7a8b9c0d1');
// eslint-disable-next-line no-control-regex
const SGR = /\x1b\[[0-9;]*m/g;

/**
 * A stand-in for a `tty.WriteStream`: only the two facts the renderer reads.
 * `colors` is how many colors the terminal shows, read the way Node's
 * `hasColors(count = 16)` reads it; 1 is a stream with no color.
 */
function terminal(facts: { columns?: number; colors?: number }): NodeJS.WritableStream {
  const colors = facts.colors;
  return {
    write: () => true,
    ...(facts.columns !== undefined ? { columns: facts.columns } : {}),
    ...(colors !== undefined ? { hasColors: (count = 16) => count <= colors } : {}),
  } as unknown as NodeJS.WritableStream;
}

/** Read the drawn half blocks back into module rows, quiet zone included. */
function decodeHalfBlocks(lines: string[]): boolean[][] {
  const rows: boolean[][] = [];
  for (const line of lines) {
    const chars = [...line.replace(SGR, '')];
    rows.push(chars.map((c) => c === '█' || c === '▀'));
    rows.push(chars.map((c) => c === '█' || c === '▄'));
  }
  return rows;
}

describe('addressQrLines', () => {
  it('draws the checksummed address at level M in 37 columns and 19 lines, then the network line', () => {
    const lines = addressQrLines(ADDRESS.toLowerCase(), terminal({ columns: 80, colors: 256 }));
    const art = lines.slice(0, -1);
    expect(lines.at(-1)).toBe(QR_NETWORK_LINE);
    expect(QR_NETWORK_LINE).toBe('USDC on Base (eip155:8453)');
    expect(art).toHaveLength(19);
    for (const line of art) expect([...line.replace(SGR, '')]).toHaveLength(37);

    // Lowercase in, EIP-55 out: the drawn modules are exactly the code for the
    // checksummed address, offset by the four-module quiet zone.
    const code = generate(ADDRESS, {
      minCorrectionLevel: correction.M,
      maxCorrectionLevel: correction.M,
    });
    const rows = decodeHalfBlocks(art);
    for (let y = 0; y < code.size; y++) {
      for (let x = 0; x < code.size; x++) {
        expect(rows[y + 4]?.[x + 4]).toBe(code.get(x, y));
      }
    }
    for (let y = 0; y < 4; y++) {
      expect(rows[y]?.some(Boolean)).toBe(false);
      expect(rows[code.size + 4 + y]?.some(Boolean)).toBe(false);
    }
  });

  it('forces black on white from the 256-color cube, which no theme remaps', () => {
    const [first] = addressQrLines(ADDRESS, terminal({ columns: 80, colors: 256 }));
    expect(first?.startsWith('\x1b[38;5;16;48;5;231m')).toBe(true);
    expect(first?.endsWith('\x1b[0m')).toBe(true);
  });

  it('fits exactly 37 columns and falls back to nothing one column narrower', () => {
    expect(addressQrLines(ADDRESS, terminal({ columns: 37, colors: 256 }))).toHaveLength(20);
    expect(addressQrLines(ADDRESS, terminal({ columns: 36, colors: 256 }))).toEqual([]);
  });

  it('draws nothing on a stream with no width, no color, only 16 colors, or no color support at all', () => {
    expect(addressQrLines(ADDRESS, terminal({ colors: 256 }))).toEqual([]);
    expect(addressQrLines(ADDRESS, terminal({ columns: 80, colors: 1 }))).toEqual([]);
    expect(addressQrLines(ADDRESS, terminal({ columns: 80, colors: 16 }))).toEqual([]);
    expect(addressQrLines(ADDRESS, terminal({ columns: 80 }))).toEqual([]);
  });

  it('draws nothing for a value that is not an EVM address', () => {
    expect(addressQrLines('not-an-address', terminal({ columns: 80, colors: 256 }))).toEqual([]);
  });
});
