import { Injectable, Logger } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository, DataSource } from "typeorm";
import { Employee } from "../entities/employee.entity";
import { LeaveBalance } from "../entities/leave-balance.entity";
import { LeaveRequest } from "../entities/leave-request.entity";
import { SyncLog } from "../entities/sync-log.entity";
import { HcmIntegrationService } from "../hcm/hcm-integration.service";
import { TimeOffService } from "../time-off/time-off.service";
import { SyncType } from "../common/constants/leave-types.constant";

export interface SyncResult {
  syncLogId: string;
  status: string;
  recordsProcessed: number;
  recordsFailed: number;
  failedEmployees: string[];
  retriedHcmSubmissions: number;
  retrySuccesses: number;
  startedAt: Date;
  completedAt: Date;
}

@Injectable()
export class SyncService {
  private readonly logger = new Logger(SyncService.name);

  constructor(
    @InjectRepository(Employee)
    private readonly employeeRepo: Repository<Employee>,
    @InjectRepository(LeaveBalance)
    private readonly balanceRepo: Repository<LeaveBalance>,
    @InjectRepository(LeaveRequest)
    private readonly requestRepo: Repository<LeaveRequest>,
    @InjectRepository(SyncLog)
    private readonly syncLogRepo: Repository<SyncLog>,
    private readonly hcmService: HcmIntegrationService,
    private readonly timeOffService: TimeOffService,
  ) {}

  // ─────────────────────────────────────────────────────────────────────────────
  // Full Sync
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Performs a full balance sync from HCM for all active employees.
   * Uses the HCM batch endpoint for efficiency.
   * Individual employee failures do not abort the whole batch.
   *
   * Also retries any leave requests with hcmSyncStatus = FAILED.
   */
  async runFullSync(
    triggeredBy: "SCHEDULER" | "MANUAL" = "SCHEDULER",
  ): Promise<SyncResult> {
    const syncLog = await this.createSyncLog("FULL", triggeredBy);
    this.logger.log(
      `[Sync ${syncLog.id}] Starting full HCM sync (triggered by: ${triggeredBy})`,
    );

    let recordsProcessed = 0;
    let recordsFailed = 0;
    const failedEmployees: string[] = [];

    try {
      // ── Attempt batch sync first ──────────────────────────────────────────
      try {
        const batchData = await this.hcmService.fetchBatchSync();
        this.logger.log(
          `[Sync ${syncLog.id}] Batch sync received ${batchData.totalCount} employee records`,
        );

        for (const record of batchData.records) {
          try {
            const employee = await this.employeeRepo.findOne({
              where: { hcmEmployeeId: record.hcmEmployeeId, isActive: true },
            });

            if (!employee) {
              this.logger.warn(
                `[Sync] Unknown HCM employee ID: ${record.hcmEmployeeId} — skipping`,
              );
              continue;
            }

            await this.timeOffService.updateLocalBalancesFromHcm(
              employee.id,
              record.locationId,
              record.balances,
            );
            recordsProcessed++;
          } catch (err) {
            recordsFailed++;
            failedEmployees.push(record.hcmEmployeeId);
            this.logger.error(
              `[Sync] Failed to update balance for HCM employee ${record.hcmEmployeeId}: ${(err as Error).message}`,
            );
          }
        }
      } catch (batchErr) {
        // Batch endpoint failed — fall back to individual employee fetches
        this.logger.warn(
          `[Sync ${syncLog.id}] Batch sync failed, falling back to individual fetches: ${(batchErr as Error).message}`,
        );
        ({ recordsProcessed, recordsFailed } =
          await this.individualFallbackSync(syncLog.id, failedEmployees));
      }

      // ── Retry failed HCM submissions ──────────────────────────────────────
      const { retried, successes } = await this.retryFailedHcmSubmissions();
      this.logger.log(
        `[Sync ${syncLog.id}] HCM retry: ${retried} attempted, ${successes} succeeded`,
      );

      const finalStatus = recordsFailed === 0 ? "SUCCESS" : "PARTIAL";
      await this.completeSyncLog(
        syncLog,
        finalStatus,
        recordsProcessed,
        recordsFailed,
        null,
      );

      return {
        syncLogId: syncLog.id,
        status: finalStatus,
        recordsProcessed,
        recordsFailed,
        failedEmployees,
        retriedHcmSubmissions: retried,
        retrySuccesses: successes,
        startedAt: syncLog.startedAt,
        completedAt: new Date(),
      };
    } catch (fatalErr) {
      this.logger.error(
        `[Sync ${syncLog.id}] Fatal sync error: ${(fatalErr as Error).message}`,
      );
      await this.completeSyncLog(
        syncLog,
        "FAILED",
        recordsProcessed,
        recordsFailed,
        (fatalErr as Error).message,
      );
      throw fatalErr;
    }
  }

  /**
   * Sync a single employee's balance from HCM.
   * Used for targeted refreshes.
   */
  async syncEmployee(employeeId: string): Promise<SyncResult> {
    const syncLog = await this.createSyncLog("INCREMENTAL", employeeId);

    const employee = await this.employeeRepo.findOne({
      where: { id: employeeId, isActive: true },
    });
    if (!employee) {
      await this.completeSyncLog(
        syncLog,
        "FAILED",
        0,
        1,
        `Employee ${employeeId} not found`,
      );
      return {
        syncLogId: syncLog.id,
        status: "FAILED",
        recordsProcessed: 0,
        recordsFailed: 1,
        failedEmployees: [employeeId],
        retriedHcmSubmissions: 0,
        retrySuccesses: 0,
        startedAt: syncLog.startedAt,
        completedAt: new Date(),
      };
    }

    try {
      const hcmResp = await this.hcmService.fetchBalance(
        employee.hcmEmployeeId,
      );
      await this.timeOffService.updateLocalBalancesFromHcm(
        employee.id,
        hcmResp.locationId,
        hcmResp.balances,
      );

      await this.completeSyncLog(syncLog, "SUCCESS", 1, 0, null);
      return {
        syncLogId: syncLog.id,
        status: "SUCCESS",
        recordsProcessed: 1,
        recordsFailed: 0,
        failedEmployees: [],
        retriedHcmSubmissions: 0,
        retrySuccesses: 0,
        startedAt: syncLog.startedAt,
        completedAt: new Date(),
      };
    } catch (err) {
      await this.completeSyncLog(
        syncLog,
        "FAILED",
        0,
        1,
        (err as Error).message,
      );
      throw err;
    }
  }

  async getSyncLogs(limit = 20): Promise<SyncLog[]> {
    return this.syncLogRepo.find({
      order: { startedAt: "DESC" },
      take: limit,
    });
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Private helpers
  // ─────────────────────────────────────────────────────────────────────────────

  private async individualFallbackSync(
    syncLogId: string,
    failedEmployees: string[],
  ): Promise<{ recordsProcessed: number; recordsFailed: number }> {
    const employees = await this.employeeRepo.find({
      where: { isActive: true },
    });
    let recordsProcessed = 0;
    let recordsFailed = 0;

    for (const employee of employees) {
      try {
        const hcmResp = await this.hcmService.fetchBalance(
          employee.hcmEmployeeId,
        );
        await this.timeOffService.updateLocalBalancesFromHcm(
          employee.id,
          hcmResp.locationId,
          hcmResp.balances,
        );
        recordsProcessed++;
      } catch (err) {
        recordsFailed++;
        failedEmployees.push(employee.id);
        this.logger.error(
          `[Sync ${syncLogId}] Individual fallback failed for ${employee.id}: ${(err as Error).message}`,
        );
      }
    }

    return { recordsProcessed, recordsFailed };
  }

  /**
   * Retry all leave requests that failed to submit to HCM.
   * Caps retries at 5 attempts; beyond that, requires manual intervention.
   */
  private async retryFailedHcmSubmissions(): Promise<{
    retried: number;
    successes: number;
  }> {
    const MAX_AUTO_RETRIES = 5;

    const failedRequests = await this.requestRepo.find({
      where: { hcmSyncStatus: "FAILED", status: "APPROVED" },
      relations: ["employee"],
    });

    let retried = 0;
    let successes = 0;

    for (const req of failedRequests) {
      if (req.hcmRetryCount >= MAX_AUTO_RETRIES) {
        this.logger.error(
          `[Sync Retry] Request ${req.id} has exceeded max retry attempts (${MAX_AUTO_RETRIES}). Manual intervention required.`,
        );
        continue;
      }

      retried++;
      req.hcmRetryCount += 1;

      try {
        const hcmResp = await this.hcmService.submitLeave({
          hcmEmployeeId: req.employee.hcmEmployeeId,
          locationId: req.locationId,
          leaveType: req.leaveType,
          startDate: req.startDate,
          endDate: req.endDate,
          daysRequested: req.daysRequested,
          reason: req.reason ?? undefined,
          idempotencyKey: req.id,
        });

        if (hcmResp.status === "ACCEPTED") {
          req.hcmSyncStatus = "SYNCED";
          req.hcmSubmissionId = hcmResp.submissionId;
          req.hcmSyncError = null;
          successes++;
          this.logger.log(
            `[Sync Retry] Request ${req.id} successfully submitted to HCM`,
          );
        } else {
          req.hcmSyncStatus = "FAILED";
          req.hcmSyncError = `HCM rejected: ${hcmResp.message}`;
        }
      } catch (err) {
        req.hcmSyncStatus = "FAILED";
        req.hcmSyncError = (err as Error).message;
        this.logger.warn(
          `[Sync Retry] Retry failed for request ${req.id}: ${(err as Error).message}`,
        );
      }

      await this.requestRepo.save(req);
    }

    return { retried, successes };
  }

  private async createSyncLog(
    syncType: SyncType,
    triggeredBy: string,
  ): Promise<SyncLog> {
    const log = this.syncLogRepo.create({
      syncType,
      status: "RUNNING",
      triggeredBy,
    });
    return this.syncLogRepo.save(log);
  }

  private async completeSyncLog(
    log: SyncLog,
    status: string,
    recordsProcessed: number,
    recordsFailed: number,
    errorMessage: string | null,
  ): Promise<void> {
    log.status = status as any;
    log.recordsProcessed = recordsProcessed;
    log.recordsFailed = recordsFailed;
    log.errorMessage = errorMessage;
    log.completedAt = new Date();
    await this.syncLogRepo.save(log);
  }
}
