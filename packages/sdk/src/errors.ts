export class EngramError extends Error {
  constructor(
    message: string,
    public readonly code?: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = "EngramError";
  }
}

export class AuthenticationError extends EngramError {
  constructor(message = "Invalid or missing API key") {
    super(message, "auth_error", 401);
    this.name = "AuthenticationError";
  }
}

export class NotFoundError extends EngramError {
  constructor(message = "Resource not found") {
    super(message, "not_found", 404);
    this.name = "NotFoundError";
  }
}

export class TimeoutError extends EngramError {
  constructor(message = "Request timed out") {
    super(message, "timeout");
    this.name = "TimeoutError";
  }
}
