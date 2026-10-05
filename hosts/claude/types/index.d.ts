/**
 * One request row as the mod draws it, written once by the `tool.call` hook so
 * the row still reads right after the CLI prunes the spec it came from. Every
 * string is user text: a label, a state and a price, never a description, URL,
 * input JSON or tool id.
 */
export type TenjinRow = {
  /** The spec's `label`, else its `provider`, else `Tenjin lookup`; `Tenjin`
   *  for the router's own calls (a spec fetch, an id-less query). */
  label: string;
  /** A call that pays from a kept spec, as opposed to one of the router's own. */
  isPaid: boolean;
  /** `for $0.007`, or `for up to $0.05` when the price varies by input. */
  price?: string;
  /** The fields sent, one `name: value` line each, sanitized and bounded. */
  fields: string[];
  /** How it ended (`$0.007 · settled`, `pending`, `needs approval`), once it has. */
  outcome?: string;
};

/** A paid call in flight, for the spinner. */
export type TenjinLive = { toolUseId: string; label: string; priceAtomic: string };

/** What one call of this turn paid, in atomic USDC. */
export type TenjinPaid = { amountAtomic: string };

declare module 'claude-code' {
  interface PluginState {
    tenjin: {
      rows: StateFamily<TenjinRow>;
      live: TenjinLive[];
      turn: TenjinPaid[];
    };
  }
}
