import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
  ConflictException,
  ServiceUnavailableException,
} from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { DataSource, Repository, Not, In } from "typeorm";
import { OptimisticLockVersionMismatchError } from "typeorm";
import { Employee } from "../entities/employee.entity";
import { LeaveBalance } from "../entities/leave-balance.entity";
import { LeaveRequest } from "../entities/leave-request.entity";
import { HcmIntegrationService } from "../hcm/hcm-integration.service";
import { ConfigService } from "@nestjs/config";
import { CreateTimeOffRequestDto } from "./dto/create-time-off-request.dto";
import { ApproveTimeOffDto } from "./dto/approve-time-off.dto";
import { LeaveType } from "../common/constants/leave-types.constant";

const MAX_OPTIMISTIC_RETRIES = 3;

@Injectable()
export class TimeOffService {
  private readonly logger = new Logger(TimeOffService.name);
  private readonly staleThresholdMs: number;
  private readonly maxStaleMs: number;

  constructor(
    @InjectRepository(Employee)
    private readonly employeeRepo: Repository<Employee>,
    @InjectRepository(LeaveBalance)
    private readonly balanceRepo: Repository<LeaveBalance>,
    @InjectRepository(LeaveRequest)
    private readonly requestRepo: Repository<LeaveRequest>,
    private readonly hcmService: HcmIntegrationService,
    private readonly config: ConfigService,
    private readonly dataSource: DataSource,
  ) {
    this.staleThresholdMs = config.get<number>(
      "balance.staleThresholdMs",
      900_000,
    );
    this.maxStaleMs = config.get<number>(
      "balance.maxAcceptableStaleMs",
      3_600_000,
    );
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Leave Request Submission
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Submit a new leave request.
   *
   * Consistency strategy:
   *  1. Try to fetch a fresh balance from HCM.
   *  2. If HCM is down, fall back to cached balance (max 1-hour stale).
   *  3. If cache is also too stale (or missing), reject the request.
   *  4. Wrap the final balance check + request creation in a transaction
   *     to prevent race conditions with concurrent requests.
   *  5. Requested days are added to pendingDays (soft reservation).
   */
  async createRequest(dto: CreateTimeOffRequestDto): Promise<LeaveRequest> {
    // ── Step 1: Idempotency check ──────────────────────────────────────────────
    if (dto.idempotencyKey) {
      const existing = await this.requestRepo.findOne({
        where: { idempotencyKey: dto.idempotencyKey },
      });
      if (existing) {
        this.logger.debug(
          `Idempotent request returned for key: ${dto.idempotencyKey}`,
        );
        return existing;
      }
    }

    // ── Step 2: Validate employee exists ──────────────────────────────────────
    const employee = await this.employeeRepo.findOne({
      where: { id: dto.employeeId, isActive: true },
    });
    if (!employee) {
      throw new NotFoundException(
        `Employee ${dto.employeeId} not found or inactive`,
      );
    }

    // ── Step 3: Calculate requested days ──────────────────────────────────────
    const daysRequested = this.calculateBusinessDays(
      dto.startDate,
      dto.endDate,
    );
    if (daysRequested <= 0) {
      throw new BadRequestException(
        "Leave request must span at least one business day",
      );
    }

    // ── Step 4: Check for overlapping requests ─────────────────────────────────
    await this.assertNoOverlap(
      dto.employeeId,
      dto.startDate,
      dto.endDate,
      dto.leaveType,
    );

    // ── Step 5: Get balance (HCM preferred, cache fallback) ──────────────────
    const locationId = dto.locationId ?? employee.locationId;
    const { balance, source } = await this.resolveBalance(
      employee,
      locationId,
      dto.leaveType as LeaveType,
      false, // liveRequired = false for request creation
    );

    if (source === "CACHE") {
      this.logger.warn(
        `Using cached balance for employee ${employee.id} (${dto.leaveType}): HCM was unreachable`,
      );
    }

    // ── Step 6: Transactional balance check + soft reservation ───────────────
    for (let attempt = 1; attempt <= MAX_OPTIMISTIC_RETRIES; attempt++) {
      try {
        return await this.dataSource.transaction(async (manager) => {
          const balanceInTx = await manager.findOneOrFail(LeaveBalance, {
            where: {
              employeeId: employee.id,
              locationId,
              leaveType: dto.leaveType as LeaveType,
            },
          });

          const available =
            balanceInTx.totalDays -
            balanceInTx.usedDays -
            balanceInTx.pendingDays;
          if (available < daysRequested) {
            throw new BadRequestException(
              `Insufficient ${dto.leaveType} balance. Available: ${available.toFixed(1)}, Requested: ${daysRequested}`,
            );
          }

          // Soft-reserve the days
          balanceInTx.pendingDays = Number(
            (balanceInTx.pendingDays + daysRequested).toFixed(2),
          );
          await manager.save(LeaveBalance, balanceInTx);

          const request = manager.create(LeaveRequest, {
            employeeId: employee.id,
            locationId,
            leaveType: dto.leaveType as LeaveType,
            startDate: dto.startDate,
            endDate: dto.endDate,
            daysRequested,
            status: "PENDING",
            reason: dto.reason ?? null,
            idempotencyKey: dto.idempotencyKey ?? null,
            hcmSyncStatus: "PENDING",
          });

          const saved = await manager.save(LeaveRequest, request);
          this.logger.log(
            `Leave request ${saved.id} created for employee ${employee.id} ` +
              `(${dto.leaveType}, ${daysRequested} days)`,
          );
          return saved;
        });
      } catch (err) {
        if (
          err instanceof OptimisticLockVersionMismatchError &&
          attempt < MAX_OPTIMISTIC_RETRIES
        ) {
          this.logger.warn(
            `Optimistic lock conflict on createRequest (attempt ${attempt}/${MAX_OPTIMISTIC_RETRIES}), retrying...`,
          );
          continue;
        }
        throw err;
      }
    }
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Approve / Reject
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Approve or reject a leave request.
   *
   * Approval consistency strategy (STRONG):
   *  1. Fetch a MANDATORY live balance from HCM — cached data is NOT acceptable.
   *  2. Wrap balance deduction + status update in a transaction.
   *  3. After commit, submit to HCM.  If HCM submission fails, mark FAILED for retry.
   *
   * Rejection consistency strategy:
   *  No balance check needed. Release pendingDays reservation.
   */
  async processApproval(
    id: string,
    dto: ApproveTimeOffDto,
  ): Promise<LeaveRequest> {
    const request = await this.requestRepo.findOne({
      where: { id },
      relations: ["employee"],
    });

    if (!request) {
      throw new NotFoundException(`Leave request ${id} not found`);
    }
    if (request.status !== "PENDING") {
      throw new BadRequestException(
        `Cannot ${dto.action.toLowerCase()} a request with status: ${request.status}`,
      );
    }

    if (dto.action === "REJECT") {
      return this.rejectRequest(request, dto);
    }

    return this.approveRequest(request, dto);
  }

  private async approveRequest(
    request: LeaveRequest,
    dto: ApproveTimeOffDto,
  ): Promise<LeaveRequest> {
    const employee = request.employee;

    // ── Step 1: MANDATORY fresh HCM balance fetch ─────────────────────────────
    let hcmBalance: {
      availableDays: number;
      totalDays: number;
      usedDays: number;
    };
    try {
      const hcmResp = await this.hcmService.fetchBalance(
        employee.hcmEmployeeId,
      );
      const hcmRecord = hcmResp.balances.find(
        (b) => b.leaveType === request.leaveType,
      );
      if (!hcmRecord) {
        throw new BadRequestException(
          `HCM has no balance record for leave type ${request.leaveType}`,
        );
      }
      hcmBalance = hcmRecord;
    } catch (err) {
      if (err instanceof ServiceUnavailableException) {
        throw err; // propagate 503 to the caller
      }
      throw err;
    }

    // ── Step 2: Count other pending days for same leave type ──────────────────
    const otherPendingResult = await this.requestRepo
      .createQueryBuilder("lr")
      .select("SUM(lr.daysRequested)", "total")
      .where("lr.employeeId = :empId", { empId: request.employeeId })
      .andWhere("lr.leaveType = :leaveType", { leaveType: request.leaveType })
      .andWhere("lr.status = :status", { status: "PENDING" })
      .andWhere("lr.id != :id", { id: request.id })
      .getRawOne();

    const otherPendingDays = Number(otherPendingResult?.total ?? 0);

    // Effective available = HCM available - other pending requests
    const effectiveAvailable = hcmBalance.availableDays - otherPendingDays;
    if (effectiveAvailable < request.daysRequested) {
      throw new BadRequestException(
        `Insufficient ${request.leaveType} balance. ` +
          `HCM available: ${hcmBalance.availableDays}, Other pending: ${otherPendingDays}, ` +
          `Effective available: ${effectiveAvailable.toFixed(1)}, Requested: ${request.daysRequested}`,
      );
    }

    // ── Step 3: Transaction — update balance + request status ─────────────────
    let approvedRequest: LeaveRequest;

    for (let attempt = 1; attempt <= MAX_OPTIMISTIC_RETRIES; attempt++) {
      try {
        approvedRequest = await this.dataSource.transaction(async (manager) => {
          const balance = await manager.findOneOrFail(LeaveBalance, {
            where: {
              employeeId: request.employeeId,
              locationId: request.locationId,
              leaveType: request.leaveType as LeaveType,
            },
          });

          // Sync our local balance with HCM's authoritative values
          balance.totalDays = hcmBalance.totalDays;
          balance.usedDays = Number(
            (hcmBalance.usedDays + request.daysRequested).toFixed(2),
          );
          balance.pendingDays = Math.max(
            0,
            Number((balance.pendingDays - request.daysRequested).toFixed(2)),
          );
          balance.hcmLastSyncedAt = new Date();
          await manager.save(LeaveBalance, balance);

          // Update request status
          request.status = "APPROVED";
          request.approvedBy = dto.approverId;
          request.approvedAt = new Date();
          // Mark as PENDING HCM sync — will be updated below after actual submission
          request.hcmSyncStatus = "PENDING";
          return manager.save(LeaveRequest, request);
        });
        break; // success — exit retry loop
      } catch (err) {
        if (
          err instanceof OptimisticLockVersionMismatchError &&
          attempt < MAX_OPTIMISTIC_RETRIES
        ) {
          this.logger.warn(
            `Optimistic lock conflict on approval (attempt ${attempt}), retrying...`,
          );
          continue;
        }
        throw err;
      }
    }

    // ── Step 4: Submit to HCM (after local commit — best-effort) ────────────
    await this.submitToHcmAfterApproval(
      approvedRequest,
      employee.hcmEmployeeId,
    );

    this.logger.log(
      `Leave request ${approvedRequest.id} approved by ${dto.approverId}`,
    );
    return approvedRequest;
  }

  private async rejectRequest(
    request: LeaveRequest,
    dto: ApproveTimeOffDto,
  ): Promise<LeaveRequest> {
    if (dto.action === "REJECT" && !dto.rejectedReason?.trim()) {
      throw new BadRequestException(
        "rejectedReason is required when rejecting a request",
      );
    }

    return this.dataSource.transaction(async (manager) => {
      // Release the pending days reservation
      const balance = await manager.findOneOrFail(LeaveBalance, {
        where: {
          employeeId: request.employeeId,
          locationId: request.locationId,
          leaveType: request.leaveType as LeaveType,
        },
      });
      balance.pendingDays = Math.max(
        0,
        Number((balance.pendingDays - request.daysRequested).toFixed(2)),
      );
      await manager.save(LeaveBalance, balance);

      request.status = "REJECTED";
      request.approvedBy = dto.approverId;
      request.approvedAt = new Date();
      request.rejectedReason = dto.rejectedReason ?? null;
      request.hcmSyncStatus = "PENDING"; // No HCM submission needed

      const saved = await manager.save(LeaveRequest, request);
      this.logger.log(
        `Leave request ${saved.id} rejected by ${dto.approverId}`,
      );
      return saved;
    });
  }

  /**
   * Attempt to submit the approved leave to HCM.
   * This is a best-effort call after the local commit succeeds.
   * On failure, we mark the request for retry rather than rolling back.
   */
  private async submitToHcmAfterApproval(
    request: LeaveRequest,
    hcmEmployeeId: string,
  ): Promise<void> {
    try {
      const hcmResp = await this.hcmService.submitLeave({
        hcmEmployeeId,
        locationId: request.locationId,
        leaveType: request.leaveType,
        startDate: request.startDate,
        endDate: request.endDate,
        daysRequested: request.daysRequested,
        reason: request.reason ?? undefined,
        idempotencyKey: request.id, // Use our request ID as the idempotency key
      });

      if (hcmResp.status === "ACCEPTED") {
        request.hcmSyncStatus = "SYNCED";
        request.hcmSubmissionId = hcmResp.submissionId;
      } else {
        request.hcmSyncStatus = "FAILED";
        request.hcmSyncError = `HCM rejected submission: ${hcmResp.message}`;
        this.logger.warn(
          `HCM rejected leave submission for request ${request.id}: ${hcmResp.message}`,
        );
      }
    } catch (err) {
      // HCM call failed — flag for retry on next sync cycle
      request.hcmSyncStatus = "FAILED";
      request.hcmSyncError = (err as Error).message;
      this.logger.error(
        `Failed to submit leave ${request.id} to HCM: ${(err as Error).message}. Queued for retry.`,
      );
    }
    await this.requestRepo.save(request);
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Balance Query
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Returns leave balances for an employee.
   * Attempts a live HCM fetch; falls back to cache with staleness metadata.
   */
  async getBalance(employeeId: string): Promise<{
    employeeId: string;
    balances: any[];
    source: "HCM" | "CACHE";
    fetchedAt: string;
  }> {
    const employee = await this.employeeRepo.findOne({
      where: { id: employeeId, isActive: true },
    });
    if (!employee) {
      throw new NotFoundException(`Employee ${employeeId} not found`);
    }

    let source: "HCM" | "CACHE" = "CACHE";

    try {
      const hcmResp = await this.hcmService.fetchBalance(
        employee.hcmEmployeeId,
      );
      // Persist the fresh HCM data to our cache
      await this.updateLocalBalancesFromHcm(
        employee.id,
        hcmResp.locationId,
        hcmResp.balances,
      );
      source = "HCM";
    } catch {
      this.logger.warn(
        `HCM unavailable for employee ${employeeId}, serving cached balance`,
      );
    }

    const localBalances = await this.balanceRepo.find({
      where: { employeeId },
    });

    const balanceDtos = localBalances.map((b) => ({
      locationId: b.locationId,
      leaveType: b.leaveType,
      totalDays: b.totalDays,
      usedDays: b.usedDays,
      pendingDays: b.pendingDays,
      availableDays: Math.max(0, b.totalDays - b.usedDays - b.pendingDays),
      hcmLastSyncedAt: b.hcmLastSyncedAt,
      isStale: b.isStale(this.staleThresholdMs),
    }));

    return {
      employeeId,
      balances: balanceDtos,
      source,
      fetchedAt: new Date().toISOString(),
    };
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // History Query
  // ─────────────────────────────────────────────────────────────────────────────

  async getHistory(
    employeeId: string,
    filters: {
      status?: string;
      leaveType?: string;
      year?: number;
      page?: number;
      limit?: number;
    },
  ): Promise<{
    data: LeaveRequest[];
    total: number;
    page: number;
    limit: number;
  }> {
    const employee = await this.employeeRepo.findOne({
      where: { id: employeeId },
    });
    if (!employee) {
      throw new NotFoundException(`Employee ${employeeId} not found`);
    }

    const { status, leaveType, year, page = 1, limit = 20 } = filters;
    const qb = this.requestRepo
      .createQueryBuilder("lr")
      .where("lr.employeeId = :employeeId", { employeeId })
      .orderBy("lr.createdAt", "DESC")
      .skip((page - 1) * limit)
      .take(limit);

    if (status) qb.andWhere("lr.status = :status", { status });
    if (leaveType) qb.andWhere("lr.leaveType = :leaveType", { leaveType });
    if (year) {
      qb.andWhere("strftime('%Y', lr.startDate) = :year", {
        year: String(year),
      });
    }

    const [data, total] = await qb.getManyAndCount();
    return { data, total, page, limit };
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Internal Helpers
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Resolves leave balance either from HCM (live) or local cache.
   * @param liveRequired  If true, throws 503 when HCM is down (used at approval).
   */
  async resolveBalance(
    employee: Employee,
    locationId: string,
    leaveType: LeaveType,
    liveRequired: boolean,
  ): Promise<{ balance: LeaveBalance; source: "HCM" | "CACHE" }> {
    try {
      const hcmResp = await this.hcmService.fetchBalance(
        employee.hcmEmployeeId,
      );
      const hcmRecord = hcmResp.balances.find((b) => b.leaveType === leaveType);
      if (!hcmRecord) {
        throw new BadRequestException(
          `HCM has no balance record for leave type ${leaveType}`,
        );
      }

      // Update local cache
      const balance = await this.updateLocalBalancesFromHcm(
        employee.id,
        hcmResp.locationId,
        hcmResp.balances,
      );
      return {
        balance: balance.find((b) => b.leaveType === leaveType)!,
        source: "HCM",
      };
    } catch (err) {
      if (liveRequired) {
        throw new ServiceUnavailableException(
          "HCM unavailable: a live balance check is required for this operation",
        );
      }

      // Attempt cache fallback
      const cached = await this.balanceRepo.findOne({
        where: { employeeId: employee.id, locationId, leaveType },
      });

      if (!cached || !cached.hcmLastSyncedAt) {
        throw new ServiceUnavailableException(
          `HCM unavailable and no local balance cache exists for ${leaveType}`,
        );
      }

      if (cached.isStale(this.maxStaleMs)) {
        throw new ServiceUnavailableException(
          `HCM unavailable and local balance cache is too stale (> ${this.maxStaleMs / 60_000} min)`,
        );
      }

      return { balance: cached, source: "CACHE" };
    }
  }

  /**
   * Updates (or creates) local LeaveBalance records from HCM data.
   * This is the write-through cache update.
   */
  async updateLocalBalancesFromHcm(
    employeeId: string,
    locationId: string,
    hcmBalances: Array<{
      leaveType: string;
      totalDays: number;
      usedDays: number;
    }>,
  ): Promise<LeaveBalance[]> {
    const updated: LeaveBalance[] = [];

    for (const hcmRecord of hcmBalances) {
      let local = await this.balanceRepo.findOne({
        where: {
          employeeId,
          locationId,
          leaveType: hcmRecord.leaveType as LeaveType,
        },
      });

      if (!local) {
        local = this.balanceRepo.create({
          employeeId,
          locationId,
          leaveType: hcmRecord.leaveType as LeaveType,
          totalDays: 0,
          usedDays: 0,
          pendingDays: 0,
        });
      }

      local.totalDays = hcmRecord.totalDays;
      // Only update usedDays if HCM's value is >= our local value
      // (to avoid clobbering days we've already deducted locally but not yet synced)
      local.usedDays = Math.max(local.usedDays, hcmRecord.usedDays);
      local.hcmLastSyncedAt = new Date();

      updated.push(await this.balanceRepo.save(local));
    }

    return updated;
  }

  /**
   * Check for overlapping approved/pending requests for the same employee
   * on the same leave type and date range.
   */
  private async assertNoOverlap(
    employeeId: string,
    startDate: string,
    endDate: string,
    leaveType: string,
  ): Promise<void> {
    const overlap = await this.requestRepo
      .createQueryBuilder("lr")
      .where("lr.employeeId = :employeeId", { employeeId })
      .andWhere("lr.leaveType = :leaveType", { leaveType })
      .andWhere("lr.status IN (:...statuses)", {
        statuses: ["PENDING", "APPROVED"],
      })
      .andWhere("lr.startDate <= :endDate", { endDate })
      .andWhere("lr.endDate >= :startDate", { startDate })
      .getOne();

    if (overlap) {
      throw new ConflictException(
        `An overlapping ${leaveType} leave request already exists ` +
          `(${overlap.startDate} – ${overlap.endDate}, status: ${overlap.status})`,
      );
    }
  }

  /**
   * Count business days (Mon–Fri) between two ISO date strings, inclusive.
   */
  calculateBusinessDays(startDate: string, endDate: string): number {
    const start = new Date(startDate);
    const end = new Date(endDate);

    if (isNaN(start.getTime()) || isNaN(end.getTime())) return 0;
    if (start > end) return 0;

    let count = 0;
    const current = new Date(start);
    while (current <= end) {
      const day = current.getDay();
      if (day !== 0 && day !== 6) count++;
      current.setDate(current.getDate() + 1);
    }
    return count;
  }
}
