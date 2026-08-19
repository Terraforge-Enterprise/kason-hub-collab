export class StaleUpdateError extends Error {
  constructor(message = "Record changed since last read") {
    super(message);
    this.name = "StaleUpdateError";
  }
}

export class NotFoundError extends Error {
  readonly entity: string;
  constructor(entity: string, message?: string) {
    super(message ?? `${entity} not found`);
    this.name = "NotFoundError";
    this.entity = entity;
  }
}

export class InvalidStateError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "InvalidStateError";
    this.code = code;
  }
}
