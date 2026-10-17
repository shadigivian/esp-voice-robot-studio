const appErrorBrand = Symbol.for("esp-voice-management.AppError");
export class AppError extends Error {
  readonly [appErrorBrand] = true;
  constructor(
    public code: string,
    message: string,
    public status = 400,
  ) {
    super(message);
    this.name = "AppError";
  }
}
export function isAppError(value: unknown): value is AppError {
  return (
    !!value &&
    typeof value === "object" &&
    (value as Record<symbol, unknown>)[appErrorBrand] === true &&
    typeof (value as AppError).message === "string" &&
    typeof (value as AppError).code === "string" &&
    Number.isInteger((value as AppError).status) &&
    (value as AppError).status >= 400 &&
    (value as AppError).status < 600
  );
}
export function assert(
  condition: unknown,
  code: string,
  message: string,
  status = 400,
): asserts condition {
  if (!condition) throw new AppError(code, message, status);
}
