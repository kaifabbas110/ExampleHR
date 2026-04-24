import { NestFactory } from "@nestjs/core";
import { ValidationPipe, Logger } from "@nestjs/common";
import { AppModule } from "./app.module";
import { AllExceptionsFilter } from "./common/filters/all-exceptions.filter";
import { LoggingInterceptor } from "./common/interceptors/logging.interceptor";

async function bootstrap() {
  const logger = new Logger("Bootstrap");
  const app = await NestFactory.create(AppModule, {
    logger: ["log", "error", "warn", "debug"],
  });

  // ── Global Validation ────────────────────────────────────────────────────────
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true, // Strip properties not in the DTO
      forbidNonWhitelisted: true,
      transform: true, // Auto-transform plain objects to DTO instances
      stopAtFirstError: false, // Collect all validation errors
    }),
  );

  // ── Global Exception Filter ──────────────────────────────────────────────────
  app.useGlobalFilters(new AllExceptionsFilter());

  // ── Global Logging Interceptor ───────────────────────────────────────────────
  app.useGlobalInterceptors(new LoggingInterceptor());

  // ── CORS (adjust origins for production) ────────────────────────────────────
  app.enableCors({
    origin: process.env.ALLOWED_ORIGINS?.split(",") ?? "*",
    methods: ["GET", "POST", "PUT", "DELETE"],
    allowedHeaders: [
      "Content-Type",
      "Authorization",
      "x-correlation-id",
      "x-employee-id",
    ],
  });

  const port = process.env.PORT ?? 3000;
  await app.listen(port);
  logger.log(`ReadyOn Time-Off Service running on http://localhost:${port}`);
  logger.log(`Mock HCM available at http://localhost:${port}/mock-hcm`);
}

bootstrap();
