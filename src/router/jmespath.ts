import { search, validate } from '@jmespath-community/jmespath';

/**
 * THE ONE PLACE THIS BUILD RUNS A CONVERSION. A routed task's seller comes
 * with two JMESPath expressions the router owns: one turns the task's input
 * into the seller's, the other turns the seller's body into the task's output.
 * They run here, on this machine, and nothing else in the CLI imports the
 * library, so a swap of it changes this file alone.
 *
 * JMESPath has no recursion and no user functions, so an expression a hostile
 * server sends cannot hang the process. Its length is bounded below, and the
 * data it reads is the bounded body the provider leg already holds.
 */

/** The longest expression this build runs. */
export const CONVERT_EXPRESSION_MAX_CHARS = 2_000;

/** Why `expression` is no expression this build will run, or undefined. */
export function expressionProblem(expression: string): string | undefined {
  if (expression.length > CONVERT_EXPRESSION_MAX_CHARS) {
    return `is over ${CONVERT_EXPRESSION_MAX_CHARS} characters`;
  }
  try {
    const checked = validate(expression);
    return checked.valid ? undefined : (checked.error ?? 'is not a JMESPath expression');
  } catch {
    return 'is not a JMESPath expression';
  }
}

/** `expression` run on `data`. Throws a plain Error on a bad expression. */
export function convertWith(expression: string, data: unknown): unknown {
  const problem = expressionProblem(expression);
  if (problem !== undefined) throw new Error(`the conversion ${problem}`);
  return search(data as never, expression) as unknown;
}
