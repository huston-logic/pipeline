// An in-memory stand-in for a Workers KV namespace, for unit tests of code that uses OAUTH_KV. It keeps values,
// metadata and expirationTtl (against a clock the test can move), and supports get, put, delete and prefix list.
type Entry = { value: string; metadata?: unknown; expiresAt?: number };

export class FakeKv {
  readonly entries = new Map<string, Entry>();
  now: () => number;

  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  #live(key: string): Entry | undefined {
    const entry = this.entries.get(key);
    if (entry?.expiresAt !== undefined && entry.expiresAt <= this.now()) {
      this.entries.delete(key);
      return undefined;
    }
    return entry;
  }

  async get(key: string, options?: string | { type?: string }): Promise<unknown> {
    const entry = this.#live(key);
    if (!entry) return null;
    const type = typeof options === "string" ? options : options?.type;
    return type === "json" ? JSON.parse(entry.value) : entry.value;
  }

  async getWithMetadata(key: string, options?: string | { type?: string }) {
    const entry = this.#live(key);
    return { value: entry ? await this.get(key, options) : null, metadata: entry?.metadata ?? null };
  }

  async put(key: string, value: string, options: { expirationTtl?: number; expiration?: number; metadata?: unknown } = {}) {
    const expiresAt =
      options.expirationTtl !== undefined
        ? this.now() + options.expirationTtl * 1000
        : options.expiration !== undefined
          ? options.expiration * 1000
          : undefined;
    this.entries.set(key, { value, ...(options.metadata === undefined ? {} : { metadata: options.metadata }), ...(expiresAt === undefined ? {} : { expiresAt }) });
  }

  async delete(key: string) {
    this.entries.delete(key);
  }

  async list(options: { prefix?: string; limit?: number; cursor?: string } = {}) {
    const names = [...this.entries.keys()].filter((name) => this.#live(name) && name.startsWith(options.prefix ?? "")).sort();
    const start = options.cursor ? Number(options.cursor) : 0;
    const limit = options.limit ?? 1000;
    const page = names.slice(start, start + limit);
    const done = start + limit >= names.length;
    return {
      keys: page.map((name) => {
        const entry = this.entries.get(name);
        return {
          name,
          ...(entry?.metadata === undefined ? {} : { metadata: entry.metadata }),
          ...(entry?.expiresAt === undefined ? {} : { expiration: Math.floor(entry.expiresAt / 1000) }),
        };
      }),
      list_complete: done,
      ...(done ? {} : { cursor: String(start + limit) }),
      cacheStatus: null,
    };
  }

  /** Keys holding the text, for checks that nothing sensitive is stored in plain text. */
  keysContaining(text: string): string[] {
    return [...this.entries].filter(([name, entry]) => name.includes(text) || entry.value.includes(text)).map(([name]) => name);
  }
}
