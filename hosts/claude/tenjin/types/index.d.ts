/**
 * One request call as the mod draws it: what it is, written by the `tool.call`
 * hook before the call runs, and how it ended, read from the request tool's
 * result envelope once it has. Every string is user text: a label, a price, a
 * state and the one input shown, never a description, JSON or a tool id.
 */
export type TenjinRow = {
  /** The service's `label`, from its spec or the result envelope. */
  label: string;
  /** `$0.007`, `$0.09` for three takes, `up to $0.05` when it varies, or
   *  `free` for a free lookup the CLI named. */
  price?: string;
  /** The one input the CLI says identifies the lookup, bounded. */
  argument?: string;
  /** The offer id the call carried, which a held native call names too. */
  offerId?: string;
  /** The envelope's `status`, once the call has ended. */
  status?: string;
  /** What left the wallet, from the envelope's `cost`, once it has ended. */
  paid?: string;
};

/** A native call the router held for an offer, or answered in place, from
 *  the CLI's offer record. */
export type TenjinHeld = {
  offerId: string;
  /** The offer's `label`, when the decision carried one. */
  label?: string;
  /** The native tool and its search or URL, to see the same call run natively. */
  key: string;
  /** The offer ran in the call's place (the swap), rather than holding it. */
  swap?: true;
  /** The offer's price, `$0.007`, from the record. */
  price?: string;
};

/** Bounded, redacted display data only; the worker controller owns execution/history/accounting. */
export type TenjinModelActivity = {
  version: 1;
  offerId: string;
  workerHandle: string;
  generation: string;
  nativeProfile: 'general-purpose' | 'Explore';
  sequence: number;
  state: 'starting' | 'running' | 'completed' | 'cancelled' | 'unknown';
  droppedRows: number;
  rows: {
    id: string;
    sequence: number;
    kind: 'text' | 'tool' | 'status' | 'compaction';
    state: string;
    name?: string;
    text?: string;
    inputSummary?: string;
    outputPreview?: string;
    elapsedSeconds?: number;
  }[];
  spend?: { reservedAtomic: string; actualAtomic: string; uncertain: string[] };
};

export type TenjinModelViewerRecord = {
  offerId: string;
  ordinal: number;
  description: string;
  profile: 'general-purpose' | 'Explore';
  active: boolean;
  nativeId?: string;
  parentId?: string;
  turnId?: string;
  workerHandle?: string;
  generation?: string;
  activity?: TenjinModelActivity;
  inspectionUnavailable?: boolean;
};

export type TenjinModelViewerState = {
  version: 1;
  parentSessionId: string;
  cwd: string;
  serial: number;
  records: TenjinModelViewerRecord[];
  /** Type guards only, never offer/execution authority. */
  knownIds: string[];
};

declare module 'claude-code' {
  interface PluginState {
    tenjin: {
      rows: StateFamily<TenjinRow>;
      held: StateFamily<TenjinHeld>;
      /** `hold:<offer id>` and `take:<offer id>`: the held native call and the
       *  request call taking it up; `ran:<key>`: a native call that ran. */
      links: StateFamily<string>;
      /** By the SHA-256 of a prompt: the label of the paid offer the CLI made
       *  on it, or '' when it made none. */
      prompts: StateFamily<string>;
      /** Start time of the latest root turn, used to reject an older offer. */
      lastTurnStart: number;
      modelViewers: TenjinModelViewerState;
    };
  }
}
