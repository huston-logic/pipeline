/** A problem with the request itself. The message is plain English and says how to fix the request. */
export class UserError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "UserError";
  }
}
