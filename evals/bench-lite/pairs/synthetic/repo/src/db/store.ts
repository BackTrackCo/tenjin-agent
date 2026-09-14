import { mergeDefaults } from '../merge.ts';

/**
 * The store.
 *
 * One process, one copy of the data, held in memory. The production build
 * swaps this module for the Postgres one; everything above it goes through
 * `Table` either way, so the two stay interchangeable.
 */
export class Table<Row extends { id: string }> {
  private readonly rows = new Map<string, Row>();

  insert(row: Row): Row {
    if (this.rows.has(row.id)) {
      throw new Error(`duplicate id: ${row.id}`);
    }
    this.rows.set(row.id, { ...row });
    return { ...row };
  }

  get(id: string): Row | undefined {
    const row = this.rows.get(id);
    return row ? { ...row } : undefined;
  }

  /** Every row, in insertion order. */
  all(): Row[] {
    return [...this.rows.values()].map((row) => ({ ...row }));
  }

  find(predicate: (row: Row) => boolean): Row | undefined {
    for (const row of this.rows.values()) {
      if (predicate(row)) {
        return { ...row };
      }
    }
    return undefined;
  }

  filter(predicate: (row: Row) => boolean): Row[] {
    return this.all().filter(predicate);
  }

  /** Layer `patch` onto the stored row and return the result. */
  update(id: string, patch: Partial<Row>): Row {
    const current = this.rows.get(id);
    if (!current) {
      throw new Error(`no such row: ${id}`);
    }
    const next = mergeDefaults(current, patch);
    this.rows.set(id, next);
    return { ...next };
  }

  remove(id: string): boolean {
    return this.rows.delete(id);
  }

  clear(): void {
    this.rows.clear();
  }

  get size(): number {
    return this.rows.size;
  }
}
