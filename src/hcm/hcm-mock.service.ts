import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { sleep } from "../common/utils/retry.util";
import {
  HcmBalanceRecord,
  HcmBalanceResponse,
  HcmBatchSyncRecord,
  HcmBatchSyncResponse,
  HcmSubmitLeaveDto,
  HcmSubmitLeaveResponse,
} from "./dto/hcm.dto";
import {
  LEAVE_TYPES,
  LeaveType,
} from "../common/constants/leave-types.constant";
import { v4 as uuidv4 } from "uuid";

/**
 * Seed balances for 5 mock employees.
 * Keyed by hcmEmployeeId.
 */
const SEED_DATA: Record<
  string,
  Record<LeaveType, { total: number; used: number }>
> = {
  "HCM-EMP-001": {
    ANNUAL: { total: 21, used: 5 },
    SICK: { total: 10, used: 2 },
    EMERGENCY: { total: 3, used: 0 },
    MATERNITY: { total: 90, used: 0 },
    PATERNITY: { total: 14, used: 0 },
    UNPAID: { total: 999, used: 0 },
  },
  "HCM-EMP-002": {
    ANNUAL: { total: 21, used: 10 },
    SICK: { total: 10, used: 3 },
    EMERGENCY: { total: 3, used: 1 },
    MATERNITY: { total: 0, used: 0 },
    PATERNITY: { total: 14, used: 0 },
    UNPAID: { total: 999, used: 0 },
  },
  "HCM-EMP-003": {
    ANNUAL: { total: 15, used: 14 },
    SICK: { total: 10, used: 8 },
    EMERGENCY: { total: 3, used: 0 },
    MATERNITY: { total: 0, used: 0 },
    PATERNITY: { total: 0, used: 0 },
    UNPAID: { total: 999, used: 10 },
  },
  "HCM-EMP-004": {
    ANNUAL: { total: 25, used: 0 },
    SICK: { total: 10, used: 0 },
    EMERGENCY: { total: 3, used: 0 },
    MATERNITY: { total: 90, used: 0 },
    PATERNITY: { total: 0, used: 0 },
    UNPAID: { total: 999, used: 0 },
  },
  "HCM-EMP-005": {
    ANNUAL: { total: 21, used: 21 }, // fully exhausted
    SICK: { total: 10, used: 10 },
    EMERGENCY: { total: 3, used: 3 },
    MATERNITY: { total: 0, used: 0 },
    PATERNITY: { total: 0, used: 0 },
    UNPAID: { total: 999, used: 0 },
  },
};

/**
 * Maps each mock HCM employee to their assigned location.
 * Balances are per-employee per-location as required by the HCM contract.
 */
const LOCATION_ASSIGNMENTS: Record<string, string> = {
  "HCM-EMP-001": "LOC-001",
  "HCM-EMP-002": "LOC-001",
  "HCM-EMP-003": "LOC-002",
  "HCM-EMP-004": "LOC-002",
  "HCM-EMP-005": "LOC-001",
};

/**
 * MockHcmService
 *
 * Simulates the HCM external system with:
 * - Configurable random failure rate
 * - Random response delays
 * - In-memory mutable balance store
 * - Idempotent leave submissions
 * - Occasional data drift simulation
 */
@Injectable()
export class HcmMockService {
  private readonly logger = new Logger(HcmMockService.name);
  private readonly failureRate: number;
  private readonly minDelayMs: number;
  private readonly maxDelayMs: number;

  /** Mutable in-memory copy of balances; starts from SEED_DATA */
  private balances: Record<
    string,
    Record<LeaveType, { total: number; used: number }>
  >;

  /** Idempotency store for leave submissions */
  private readonly submissionCache = new Map<string, HcmSubmitLeaveResponse>();

  constructor(private readonly config: ConfigService) {
    this.failureRate = config.get<number>("mockHcm.failureRate", 0.2);
    this.minDelayMs = config.get<number>("mockHcm.minDelayMs", 50);
    this.maxDelayMs = config.get<number>("mockHcm.maxDelayMs", 500);
    this.balances = this.cloneSeedData();
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Public API methods (called by HcmMockController)
  // ─────────────────────────────────────────────────────────────────────────────

  async getBalance(hcmEmployeeId: string): Promise<HcmBalanceResponse> {
    await this.simulateLatency();
    this.simulateFailure("getBalance");

    const employeeData = this.balances[hcmEmployeeId];
    if (!employeeData) {
      throw Object.assign(
        new Error(`Employee ${hcmEmployeeId} not found in HCM`),
        { status: 404 },
      );
    }

    const balances: HcmBalanceRecord[] = (
      LEAVE_TYPES as readonly LeaveType[]
    ).map((type) => {
      const record = employeeData[type] ?? { total: 0, used: 0 };
      // Occasionally introduce slight drift to simulate HCM-side changes
      const driftedUsed = this.maybeDrift(record.used, record.total);
      return {
        leaveType: type,
        totalDays: record.total,
        usedDays: driftedUsed,
        availableDays: Math.max(0, record.total - driftedUsed),
      };
    });

    return {
      hcmEmployeeId,
      locationId: LOCATION_ASSIGNMENTS[hcmEmployeeId] ?? "LOC-001",
      balances,
      asOf: new Date().toISOString(),
    };
  }

  async submitLeave(dto: HcmSubmitLeaveDto): Promise<HcmSubmitLeaveResponse> {
    await this.simulateLatency();
    this.simulateFailure("submitLeave");

    // Idempotency: return cached response if same key used
    if (dto.idempotencyKey && this.submissionCache.has(dto.idempotencyKey)) {
      this.logger.debug(
        `[HCM Mock] Idempotent response for key: ${dto.idempotencyKey}`,
      );
      return this.submissionCache.get(dto.idempotencyKey);
    }

    const employeeData = this.balances[dto.hcmEmployeeId];
    if (!employeeData) {
      throw Object.assign(
        new Error(`Employee ${dto.hcmEmployeeId} not found in HCM`),
        { status: 404 },
      );
    }

    const leaveType = dto.leaveType as LeaveType;
    const balance = employeeData[leaveType];
    const available = balance.total - balance.used;

    if (available < dto.daysRequested) {
      // HCM rejects the submission (balance mismatch)
      const resp: HcmSubmitLeaveResponse = {
        submissionId: null,
        status: "REJECTED",
        message: `Insufficient balance in HCM. Available: ${available}, Requested: ${dto.daysRequested}`,
        processedAt: new Date().toISOString(),
      };
      return resp;
    }

    // Deduct from HCM balance
    balance.used += dto.daysRequested;

    const submissionId = `HCM-SUBM-${uuidv4().split("-")[0].toUpperCase()}`;
    const resp: HcmSubmitLeaveResponse = {
      submissionId,
      status: "ACCEPTED",
      message: "Leave submission accepted",
      processedAt: new Date().toISOString(),
    };

    if (dto.idempotencyKey) {
      this.submissionCache.set(dto.idempotencyKey, resp);
    }

    return resp;
  }

  async getBatchSync(): Promise<HcmBatchSyncResponse> {
    await this.simulateLatency();
    this.simulateFailure("getBatchSync");

    const records: HcmBatchSyncRecord[] = Object.entries(this.balances).map(
      ([hcmEmployeeId, data]) => ({
        hcmEmployeeId,
        locationId: LOCATION_ASSIGNMENTS[hcmEmployeeId] ?? "LOC-001",
        balances: (LEAVE_TYPES as readonly LeaveType[]).map((type) => {
          const record = data[type] ?? { total: 0, used: 0 };
          return {
            leaveType: type,
            totalDays: record.total,
            usedDays: record.used,
            availableDays: Math.max(0, record.total - record.used),
          };
        }),
      }),
    );

    return {
      records,
      totalCount: records.length,
      generatedAt: new Date().toISOString(),
    };
  }

  /** Resets mock data to seed values (used in tests) */
  reset(): void {
    this.balances = this.cloneSeedData();
    this.submissionCache.clear();
    this.logger.log("[HCM Mock] Data reset to seed values");
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Private helpers
  // ─────────────────────────────────────────────────────────────────────────────

  private simulateFailure(operation: string): void {
    if (Math.random() < this.failureRate) {
      this.logger.warn(`[HCM Mock] Simulated failure on ${operation}`);
      const err = new Error("HCM internal server error (simulated)");
      Object.assign(err, { status: 500 });
      throw err;
    }
  }

  private async simulateLatency(): Promise<void> {
    const delay =
      this.minDelayMs + Math.random() * (this.maxDelayMs - this.minDelayMs);
    await sleep(delay);
  }

  /**
   * With 10% probability, returns a slightly different used value to simulate
   * HCM-side changes (e.g., HR admin manually adjusting balances).
   */
  private maybeDrift(used: number, total: number): number {
    if (Math.random() < 0.1) {
      const drift = Math.random() < 0.5 ? 0.5 : -0.5;
      return Math.max(0, Math.min(total, used + drift));
    }
    return used;
  }

  private cloneSeedData(): typeof SEED_DATA {
    return JSON.parse(JSON.stringify(SEED_DATA));
  }
}
