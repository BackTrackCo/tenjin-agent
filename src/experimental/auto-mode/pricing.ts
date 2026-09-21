import { USDC_ADDRESS, USDC_DECIMALS } from '../../lib/usdc';
import type { AutoContract } from './contracts';

interface PriceRange {
  minCeilingAtomic: string;
  maxCeilingAtomic: string;
  minCeilingUSDC: string;
  maxCeilingUSDC: string;
}

interface PriceBasis {
  currency: 'USDC';
  network: 'eip155:8453';
  decimals: 6;
  basis: 'advertised-ceiling';
  liveQuoteRequired: true;
  supportedAlternatives: number;
  pricedAlternatives: number;
  ignoredAlternatives: number;
}

export type AdvertisedPrice = PriceBasis &
  (
    | ({
        status: 'known';
        comparisonCeilingAtomic: string;
        comparisonCeilingUSDC: string;
      } & PriceRange)
    | {
        status: 'unknown';
        reason: 'no-supported-alternatives' | 'missing-or-invalid-amount' | 'partial-pricing';
        knownRange?: PriceRange;
      }
  );

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
// Match the executor's canonical atomic amount representation. Reject an
// oversized string before parsing; never use Number for atomic USDC values.
const ATOMIC = /^(0|[1-9]\d{0,29})$/;
const SCALE = 10n ** BigInt(USDC_DECIMALS);

function usdc(amount: bigint): string {
  const remainder = (amount % SCALE).toString().padStart(USDC_DECIMALS, '0').replace(/0+$/, '');
  return `${amount / SCALE}${remainder ? `.${remainder}` : ''}`;
}

/** Display only. Advertised alternatives are ceilings, not live quotes or
 * spending authorization. A missing price is unknown even beside a priced
 * alternative; the latter does not establish which offers the server will send. */
export function advertisedPrice(contract: Pick<AutoContract, 'accepts'>): AdvertisedPrice {
  let supportedAlternatives = 0;
  let pricedAlternatives = 0;
  let ignoredAlternatives = 0;
  let minimum: bigint | undefined;
  let maximum: bigint | undefined;
  for (const raw of contract.accepts) {
    const offer =
      raw !== null && typeof raw === 'object' && !Array.isArray(raw)
        ? (raw as Record<string, unknown>)
        : {};
    if (
      offer.scheme !== 'exact' ||
      offer.network !== 'eip155:8453' ||
      typeof offer.asset !== 'string' ||
      offer.asset.toLowerCase() !== USDC_ADDRESS.toLowerCase() ||
      typeof offer.payTo !== 'string' ||
      !ADDRESS.test(offer.payTo)
    ) {
      ignoredAlternatives++;
      continue;
    }
    supportedAlternatives++;
    const amount = offer.amount ?? offer.maxAmountRequired;
    if (typeof amount !== 'string' || amount.length > 80 || !ATOMIC.test(amount)) continue;
    const atomic = BigInt(amount);
    pricedAlternatives++;
    if (minimum === undefined || atomic < minimum) minimum = atomic;
    if (maximum === undefined || atomic > maximum) maximum = atomic;
  }
  const basis: PriceBasis = {
    currency: 'USDC',
    network: 'eip155:8453',
    decimals: USDC_DECIMALS,
    basis: 'advertised-ceiling',
    liveQuoteRequired: true,
    supportedAlternatives,
    pricedAlternatives,
    ignoredAlternatives,
  };
  const range: PriceRange | undefined =
    minimum === undefined || maximum === undefined
      ? undefined
      : {
          minCeilingAtomic: minimum.toString(),
          maxCeilingAtomic: maximum.toString(),
          minCeilingUSDC: usdc(minimum),
          maxCeilingUSDC: usdc(maximum),
        };
  if (!range || pricedAlternatives !== supportedAlternatives)
    return {
      ...basis,
      status: 'unknown',
      reason: !supportedAlternatives
        ? 'no-supported-alternatives'
        : range
          ? 'partial-pricing'
          : 'missing-or-invalid-amount',
      ...(range ? { knownRange: range } : {}),
    };
  return {
    ...basis,
    status: 'known',
    ...range,
    comparisonCeilingAtomic: range.maxCeilingAtomic,
    comparisonCeilingUSDC: range.maxCeilingUSDC,
  };
}
