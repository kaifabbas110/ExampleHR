import { Module } from "@nestjs/common";
import { ConfigModule, ConfigService } from "@nestjs/config";
import { TypeOrmModule } from "@nestjs/typeorm";
import { ScheduleModule } from "@nestjs/schedule";
import configuration from "./config/configuration";
import { Employee } from "./entities/employee.entity";
import { LeaveBalance } from "./entities/leave-balance.entity";
import { LeaveRequest } from "./entities/leave-request.entity";
import { SyncLog } from "./entities/sync-log.entity";
import { HcmModule } from "./hcm/hcm.module";
import { EmployeesModule } from "./employees/employees.module";
import { TimeOffModule } from "./time-off/time-off.module";
import { SyncModule } from "./sync/sync.module";
import * as path from "path";
import * as fs from "fs";

@Module({
  imports: [
    // ── Configuration ──────────────────────────────────────────────────────────
    ConfigModule.forRoot({
      isGlobal: true,
      load: [configuration],
      envFilePath: [".env", ".env.local"],
    }),

    // ── Scheduler (for cron jobs) ──────────────────────────────────────────────
    ScheduleModule.forRoot(),

    // ── Database ───────────────────────────────────────────────────────────────
    TypeOrmModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const dbPath = config.get<string>("database.path", "./data/readyon.db");

        // Ensure the data directory exists
        const dir = path.dirname(dbPath);
        if (dir && dir !== "." && !fs.existsSync(dir)) {
          fs.mkdirSync(dir, { recursive: true });
        }

        return {
          type: "better-sqlite3",
          database: dbPath,
          entities: [Employee, LeaveBalance, LeaveRequest, SyncLog],
          // synchronize: true creates/updates tables automatically.
          // In production, replace with migrations (synchronize: false, migrationsRun: true).
          synchronize: true,
          logging:
            config.get<string>("nodeEnv") === "development"
              ? ["error", "warn"]
              : ["error"],
          // WAL mode for better concurrent read performance in SQLite
          nativeBinding: undefined,
        };
      },
    }),

    // ── Feature Modules ────────────────────────────────────────────────────────
    HcmModule,
    EmployeesModule,
    TimeOffModule,
    SyncModule,
  ],
})
export class AppModule {}
