import {
  Body,
  Controller,
  Get,
  Post,
  Query,
  HttpCode,
  HttpStatus,
} from "@nestjs/common";
import { SyncService } from "./sync.service";

@Controller("sync")
export class SyncController {
  constructor(private readonly syncService: SyncService) {}

  /**
   * POST /sync/hcm
   * Trigger a manual full HCM sync. Returns 202 Accepted immediately
   * (sync runs asynchronously; poll /sync/logs for results).
   *
   * Body: { employeeId?: string }  — if provided, syncs only that employee.
   */
  @Post("hcm")
  @HttpCode(HttpStatus.ACCEPTED)
  async triggerSync(@Body() body: { employeeId?: string }) {
    if (body?.employeeId) {
      // Targeted single-employee sync
      const result = await this.syncService.syncEmployee(body.employeeId);
      return result;
    }

    // Full sync — fire and forget, return the log immediately
    const resultPromise = this.syncService.runFullSync("MANUAL");
    resultPromise.catch((err) => {
      // Error is already logged inside SyncService
    });

    // Return a preliminary response; the sync log ID will be available
    // once the sync starts. For simplicity, we await the first tick.
    const result = await resultPromise;
    return { message: "HCM sync triggered", ...result };
  }

  /**
   * GET /sync/logs?limit=20
   * Returns recent sync log entries.
   */
  @Get("logs")
  getLogs(@Query("limit") limit?: string) {
    return this.syncService.getSyncLogs(
      limit ? Math.min(parseInt(limit, 10), 100) : 20,
    );
  }
}
