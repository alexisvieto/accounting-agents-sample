import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";

export type Row = Record<string, unknown>;
export type Query = (sql: string, params?: unknown[]) => Promise<Row[]>;

/**
 * The company's books in an in-memory PostgreSQL (PGlite). Swapping it for a
 * real server changes this file only: the rules live in the SQL.
 */
export class Books {
  private queue: Promise<unknown> = Promise.resolve();
  private pg: PGlite;

  private constructor(pg: PGlite) {
    this.pg = pg;
  }

  static async open(withSeed = true) {
    const pg = new PGlite();
    for (const file of withSeed ? ["schema.sql", "seed.sql"] : ["schema.sql"]) {
      await pg.exec(await readFile(new URL(`../sql/${file}`, import.meta.url), "utf8"));
    }
    return new Books(pg);
  }

  /** Runs fn in one transaction as the agent's role. Its grants are all it has. */
  asAgent<T>(role: string, fn: (q: Query) => Promise<T>): Promise<T> {
    if (!/^agent_[a-z]+$/.test(role)) throw new Error(`Not an agent role: ${role}`);
    return this.transaction(async (q) => {
      await q(`set local role ${role}`);
      return fn(q);
    });
  }

  /** The harness and people (approvals, the action log) write as the owner. */
  asOwner<T>(fn: (q: Query) => Promise<T>): Promise<T> {
    return this.transaction(fn);
  }

  close() {
    return this.pg.close();
  }

  // One connection, so transactions must not interleave.
  private transaction<T>(fn: (q: Query) => Promise<T>): Promise<T> {
    const run = this.queue.then(async () => {
      const q: Query = async (sql, params) => (await this.pg.query(sql, params)).rows as Row[];
      await q("begin");
      try {
        const result = await fn(q);
        await q("commit");
        return result;
      } catch (err) {
        await q("rollback");
        throw err;
      }
    });
    this.queue = run.catch(() => {});
    return run;
  }
}
