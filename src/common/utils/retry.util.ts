import { Logger } from "@nestjs/common";

const logger = new Logger("RetryUtil");

export interface RetryOptions {
  /** Maximum number of attempts (including the first try). Default: 3 */
  maxRetries?: number;
  /** Initial delay in ms before first retry. Default: 500 */
  baseDelayMs?: number;
  /** Maximum delay cap in ms. Default: 5000 */
  maxDelayMs?: number;
  /** Label for log messages. Default: 'operation' */
  label?: string;
  /** If provided, only retry when this predicate returns true for the error. */
  retryIf?: (error: unknown) => boolean;
}

/**
 * Executes fn() with exponential backoff retry on failure.
 *
 * Delay formula: min(baseDelayMs * 2^(attempt-1), maxDelayMs)
 *
 * @throws The last error after all retries are exhausted.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const {
    maxRetries = 3,
    baseDelayMs = 500,
    maxDelayMs = 5000,
    label = "operation",
    retryIf,
  } = options;

  let lastError: unknown;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;

      // If the error is not retryable, fail immediately
      if (retryIf && !retryIf(error)) {
        logger.warn(
          `[${label}] Non-retryable error on attempt ${attempt}: ${(error as Error).message}`,
        );
        throw error;
      }

      if (attempt < maxRetries) {
        const delay = Math.min(
          baseDelayMs * Math.pow(2, attempt - 1),
          maxDelayMs,
        );
        logger.warn(
          `[${label}] Attempt ${attempt}/${maxRetries} failed: ${(error as Error).message}. Retrying in ${delay}ms...`,
        );
        await sleep(delay);
      } else {
        logger.error(
          `[${label}] All ${maxRetries} attempts failed. Last error: ${(error as Error).message}`,
        );
      }
    }
  }

  throw lastError;
}

/** Resolves after the given number of milliseconds. */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Returns true if an HTTP error status code is retryable (i.e. 5xx or network errors),
 * false for client errors (4xx) which should not be retried.
 */
export function isRetryableHttpError(error: unknown): boolean {
  if (!error || typeof error !== "object") return true;
  const status = (error as any)?.response?.status ?? (error as any)?.status;
  if (typeof status === "number") {
    // Do not retry client errors (400-499) except 429 Too Many Requests
    return status >= 500 || status === 429;
  }
  // Network errors (no status) are retryable
  return true;
}
