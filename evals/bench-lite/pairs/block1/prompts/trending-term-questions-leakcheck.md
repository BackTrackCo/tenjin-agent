# Leak check — trending-term-questions (v2 prompts)

## The shared fact, from the producer (tenjin #727)

The question surfaces are SEPARATE POPULATIONS, not one stream: four public tiers plus a
moderation queue. #727 is the PR that makes them four by adding the converted tier and its
conversion rule, and that establishes the shared exclusion semantics every tier reads.

Established by #727, absent at its base commit `35f5a2f`:

- `getConvertedQuestions(db, { days, limit, maxPerRequester })` in `lib/search-telemetry.ts`, the
  "Answered and bought" tier: a settled payment by a party other than the piece's owner converts
  the NORMALIZED question group, with no distinct-requester floor, over a longer window than the
  other tiers.
- `isPublishableQuestionShape(query)` and the three shape rules behind it.
- `ANSWER_BODY_EXAMPLE` in `lib/payments/answer-example.ts`, the one documented sample question
  excluded everywhere.
- The reserved probe-question prefix `zzq_probe_` (no occurrence anywhere under `lib/` at the
  producer's base).
- `converted` on `readTrendingPageDemand`, and the page's three-section order.

Pre-existing at the producer's base, and therefore NOT shared fact: `getAgentQuestions`,
`getWaitingQuestions`, `getAnsweredQuestions`, `getPendingAgentQuestions`, `getTopSearchTerms`,
`readTrendingDemand`, `readLandingQuestions`, the 24-hour persistence delay, the per-requester
cap, the display-length cap, `PROBE_CLIENT_NAMES`, and the `hidden_search_terms` operator veto.

## Why the consumer needs it

`#740` must apply one suppression rule to every public tier and to none of the queue. Its oracle
runs the rule against four tier readers by name through `queries[method]` and then asserts the
queue still holds all five questions. An agent that finds three public readers passes three of the
four parameterised cases and fails the fourth; an agent that applies it to the queue as well fails
every case's second assertion.

## Grep, run against the v2 consumer prompt

```
$ grep -inE "getConvertedQuestions|converted|convert|bought|purchase|payment|settle|four (public )?(question )?tier|answered and bought|ANSWER_BODY_EXAMPLE|isPublishableQuestionShape|getAnsweredQuestions|getAgentQuestions|getWaitingQuestions" \
    prompts/trending-term-questions-consumer.md
46:  not containing `'zinc target'`, and `getAgentQuestions` still returns nothing for the
53:  `getWaitingQuestions` again.
56:  `getAgentQuestions` and stays in `getPendingAgentQuestions`.
83:relevant focused tests only. Services, installs, payments, and publication must use the supplied

$ grep -inE "shape|zzq_probe_|tenjin-eval|sample question" prompts/trending-term-questions-consumer.md
(no output)
```

Zero hits on the shared fact. The three reader hits are `getAgentQuestions`,
`getWaitingQuestions` and `getPendingAgentQuestions`, all present at the producer's base commit.
The fourth hit is the word "payments" inside the unchanged boilerplate constraint paragraph.

## Deliberate omission, and the cost

The v2 consumer prompt states the suppression rule as applying to "EVERY public question tier
reader that `lib/search-telemetry.ts` exports", and never enumerates them or gives their count.
That is the measured gap: the agent has to read the module to learn how many there are. Naming
them would hand over the producer's contribution outright, since the converted tier is the fourth.

The queue is named (`getPendingAgentQuestions`) because it predates the producer and because the
consumer's own oracle asserts on it directly.

## Removed from the v1 consumer prompt

- "Prevent bare catalog terms ... from also appearing in any of the four public question tiers."
  The word "four" is the producer's contribution, stated as a count.
- "Preserve those questions in the moderation queue" is kept, since the queue predates #727.
- "the reserved probe prefix `zzq_probe_`" was removed from the preserved-behaviour bullet: the
  prefix is #727's. The bullet now says "every existing probe-question and probe-client
  exclusion", which is what the consumer must preserve and nothing more.

## Oracle-level leak, flagged not fixed

`oracles/trending-term-questions.test.ts` parameterises over the four public tier names as string
literals, so running the oracle discloses the full enumeration, including
`getConvertedQuestions`. Unavoidable: the consumer's contract IS "apply this to all of them".
The disclosure arrives at run time rather than in the prompt, which is the same posture as the
other three pairs' constant-name leaks.
