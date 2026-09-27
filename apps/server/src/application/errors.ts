export class Rejection extends Error {
  constructor(
    public readonly code: string,
    public readonly fields?: string[],
  ) {
    super(code);
  }
}
export class Deferral extends Error {
  constructor(public readonly code: string) {
    super(code);
  }
}
export class ProtocolConflict extends Error {}
export class NotFound extends Error {}
export class Unauthenticated extends Error {}
