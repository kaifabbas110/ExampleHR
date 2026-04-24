import {
  ExceptionFilter,
  Catch,
  ArgumentsHost,
  HttpException,
  HttpStatus,
  Logger,
} from "@nestjs/common";
import { Request, Response } from "express";
import { OptimisticLockVersionMismatchError, QueryFailedError } from "typeorm";

/**
 * Global exception filter that catches all unhandled exceptions and returns
 * a standardised JSON error response. Logs errors with full context.
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    const { status, message } = this.resolveError(exception);

    const errorBody = {
      statusCode: status,
      message,
      timestamp: new Date().toISOString(),
      path: request.url,
      method: request.method,
    };

    if (status >= 500) {
      this.logger.error(
        `[${request.method}] ${request.url} → ${status}: ${message}`,
        exception instanceof Error ? exception.stack : undefined,
      );
    } else {
      this.logger.warn(
        `[${request.method}] ${request.url} → ${status}: ${message}`,
      );
    }

    response.status(status).json(errorBody);
  }

  private resolveError(exception: unknown): {
    status: number;
    message: string;
  } {
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const responseBody = exception.getResponse();
      const message =
        typeof responseBody === "object" &&
        "message" in (responseBody as object)
          ? (responseBody as any).message
          : exception.message;
      const finalMessage = Array.isArray(message)
        ? message.join("; ")
        : String(message);
      return { status, message: finalMessage };
    }

    // Optimistic lock conflicts → 409
    if (exception instanceof OptimisticLockVersionMismatchError) {
      return {
        status: HttpStatus.CONFLICT,
        message: "Concurrent update detected, please retry",
      };
    }

    // Unique constraint violations → 409
    if (exception instanceof QueryFailedError) {
      const msg = (exception as any).message as string;
      if (msg && msg.toLowerCase().includes("unique")) {
        return {
          status: HttpStatus.CONFLICT,
          message: "Duplicate record: unique constraint violated",
        };
      }
    }

    return {
      status: HttpStatus.INTERNAL_SERVER_ERROR,
      message: "An unexpected error occurred",
    };
  }
}
