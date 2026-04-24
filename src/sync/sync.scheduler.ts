import { Injectable, Logger } from "@nestjs/common";
import { Cron } from "@nestjs/schedule";
import { ConfigService } from "@nestjs/config";
import { SyncService } from "./sync.service";

/**
 * SyncScheduler
 *
 * Runs the HCM balance sync on a configurable cron schedule (default: every 15 min).
 * Can be disabled via the SYNC_ENABLED env variable.
 */
@Injectable()
export class SyncScheduler {
  private readonly logger = new Logger(SyncScheduler.name);
  private readonly syncEnabled: boolean;
  private isRunning = false;

  constructor(
    private readonly syncService: SyncService,
    private readonly config: ConfigService,
  ) {
    this.syncEnabled = config.get<boolean>("sync.enabled", true);
  }

  /**
   * Runs every 15 minutes by default.
   * The actual schedule is driven by the SYNC_CRON_SCHEDULE env var.
   * Note: NestJS @Cron does not support runtime-configurable expressions;
   * the hardcoded '0 *\/15 * * * *' here is the default. To change the schedule,
   * update this decorator and rebuild, or set the env var before build.
   */
  @Cron("0 */15 * * * *", { name: "hcm-balance-sync" })
  async handleCron(): Promise<void> {
    if (!this.syncEnabled) {
      this.logger.debug(
        "Sync is disabled (SYNC_ENABLED=false), skipping cron run",
      );
      return;
    }

    // Prevent overlapping runs — skip if a sync is already in progress
    if (this.isRunning) {
      this.logger.warn(
        "Previous sync is still running, skipping this cron tick",
      );
      return;
    }

    this.isRunning = true;
    const startTime = Date.now();
    this.logger.log("Cron sync triggered");

    try {
      const result = await this.syncService.runFullSync("SCHEDULER");
      const duration = Date.now() - startTime;
      this.logger.log(
        `Cron sync completed in ${duration}ms: ` +
          `processed=${result.recordsProcessed}, failed=${result.recordsFailed}, ` +
          `status=${result.status}`,
      );
    } catch (err) {
      this.logger.error(`Cron sync failed: ${(err as Error).message}`);
    } finally {
      this.isRunning = false;
    }
  }
}
