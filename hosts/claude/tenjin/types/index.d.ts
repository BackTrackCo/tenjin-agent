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

/** A native call the router held for an offer, from the CLI's offer record. */
export type TenjinHeld = {
  offerId: string;
  /** The offer's `label`, when the decision carried one. */
  label?: string;
  /** The native tool and its search or URL, to see the same call run natively. */
  key: string;
};

/** A routed subagent's effort, by its agent id (`hooks/agent-effort.ts`). */
export type TenjinAgentRun = { effort: string; toolUseId: string };

/** One changed dimension of a delegated task: to what, from what, and whether it ran so. */
export type TenjinAgentPart = {
  to: string;
  from?: string;
  done: boolean;
  /** The model the host resolved a changed tier to (`haiku` to its current Haiku). */
  resolved?: string;
};

/** The facts of one Agent row's line, by the call's `tool_use_id` (`hooks/agents.tsx`). */
export type TenjinAgentRow = {
  holdout?: true;
  /** Its Haiku run gave no usable answer, so it ran again as asked. */
  respawned?: true;
  /** A tier (`sonnet`), when the model changed or would. */
  model?: TenjinAgentPart;
  /** An effort level, when the effort changed or would. */
  effort?: TenjinAgentPart;
  reason?: string;
  /** Estimated percent less usage. */
  saving?: number;
};

/** This session's delegated tasks the agent leg recorded, for the status line. */
export type TenjinAgentCounts = {
  model: 'off' | 'shadow' | 'apply';
  effort: 'off' | 'shadow' | 'apply';
  spawns: number;
  routed: number;
  held: number;
  would: number;
  /** Haiku runs with no usable answer, run again as asked. */
  respawned?: number;
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
      agentRuns: StateFamily<TenjinAgentRun>;
      agentRows: StateFamily<TenjinAgentRow>;
      agentCounts: TenjinAgentCounts;
    };
  }
}
