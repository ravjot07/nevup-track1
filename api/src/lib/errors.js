export function errorBody(error, message, traceId) {
  return { error, message, traceId };
}

export class HttpError extends Error {
  constructor(statusCode, code, message) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
  }
}

export const Forbidden = (message = 'Cross-tenant access denied.') =>
  new HttpError(403, 'FORBIDDEN', message);

export const Unauthorized = (message = 'Missing or invalid token.') =>
  new HttpError(401, 'UNAUTHORIZED', message);

export const NotFound = (message = 'Resource not found.') =>
  new HttpError(404, 'NOT_FOUND', message);

export const BadRequest = (message = 'Invalid request.') =>
  new HttpError(400, 'BAD_REQUEST', message);
