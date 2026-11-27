export function isNotFound(err: unknown): boolean {
  return (err as DOMException)?.name === 'NotFoundError';
}

export function describeReadError(err: unknown): string {
  const message = (err as DOMException)?.message;
  return typeof message === 'string' && message ? message : String(err);
}
