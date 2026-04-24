import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
  Logger,
} from "@nestjs/common";
import { Observable } from "rxjs";
import { tap } from "rxjs/operators";
import { v4 as uuidv4 } from "uuid";

/**
 * Logs incoming requests and outgoing responses with duration.
 * Attaches a correlation ID to each request for traceability.
 */
@Injectable()
export class LoggingInterceptor implements NestInterceptor {
  private readonly logger = new Logger("HTTP");

  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    const req = context.switchToHttp().getRequest();
    const correlationId =
      (req.headers["x-correlation-id"] as string) || uuidv4();
    req.correlationId = correlationId;

    const { method, url, body } = req;
    const startTime = Date.now();

    // Set correlation ID on response header before the response is committed
    const res = context.switchToHttp().getResponse();
    res.setHeader("x-correlation-id", correlationId);

    this.logger.log(`→ [${correlationId}] ${method} ${url}`);

    return next.handle().pipe(
      tap({
        next: () => {
          const duration = Date.now() - startTime;
          this.logger.log(
            `← [${correlationId}] ${method} ${url} ${res.statusCode} (${duration}ms)`,
          );
        },
        error: (err) => {
          const duration = Date.now() - startTime;
          this.logger.warn(
            `← [${correlationId}] ${method} ${url} ERROR (${duration}ms): ${err.message}`,
          );
        },
      }),
    );
  }
}
