/** A problem with the request itself. The message is plain English and says how to fix the request. */
export class UserError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UserError";
  }
}
