// Stand-in for the Workers runtime's `cloudflare:workers` module in Node unit tests (see workers-runtime.mjs).
export class WorkerEntrypoint {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
  }
}
