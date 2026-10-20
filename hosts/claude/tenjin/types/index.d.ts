/**
 * One request row as the mod draws it, written once by the `tool.call` hook so
 * the row still reads right after the CLI prunes the spec it came from, and
 * kept a second time under `held:<held call id>` once it takes up a native
 * call held for its offer, so that call's row draws it from its first frame. Every string is user text: a label, a price, a state
 * and the one input shown, never a description, JSON or tool id.
 */
export type TenjinRow = {
  /** The spec's `label`, else `Tenjin lookup`; `Tenjin` for the router's own
   *  calls (a spec fetch, an id-less query). */
  label: string;
  /** A call that pays from a kept spec, as opposed to one of the router's own. */
  isPaid: boolean;
  /** `$0.007`, or `up to $0.05` when the price varies by input. */
  price?: string;
  /** The one input shown: the query, the URL, else the first field, bounded. */
  argument?: string;
  /** The offer id the call carried, which a held native call names too. */
  offerId?: string;
  /** The held native call this call took up, whose row draws it in its place. */
  holdOf?: string;
  /** How it ended (`$0.007 · settled`, `pending`, `needs approval`), once it has. */
  outcome?: string;
};

/**
 * A paid call in flight, for the spinner; or, with `heldOffer`, a native call
 * held for that offer id whose request call has not run yet.
 */
export type TenjinLive = {
  toolUseId: string;
  label: string;
  priceAtomic: string;
  heldOffer?: string;
};

/** What one call of this turn paid, in atomic USDC. */
export type TenjinPaid = { amountAtomic: string };

declare module 'claude-code' {
  interface PluginState {
    tenjin: {
      rows: StateFamily<TenjinRow>;
      live: TenjinLive[];
      turn: TenjinPaid[];
      /** The first-run wallet toast showed in this session. */
      welcomed: boolean;
    };
  }
}
