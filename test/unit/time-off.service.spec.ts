import { Test, TestingModule } from "@nestjs/testing";
import { getRepositoryToken } from "@nestjs/typeorm";
import { DataSource, Repository } from "typeorm";
import {
  NotFoundException,
  BadRequestException,
  ConflictException,
  ServiceUnavailableException,
} from "@nestjs/common";
import { TimeOffService } from "../../src/time-off/time-off.service";
import { Employee } from "../../src/entities/employee.entity";
import { LeaveBalance } from "../../src/entities/leave-balance.entity";
import { LeaveRequest } from "../../src/entities/leave-request.entity";
import { HcmIntegrationService } from "../../src/hcm/hcm-integration.service";
import { ConfigService } from "@nestjs/config";

// ─── Factories ────────────────────────────────────────────────────────────────

function makeEmployee(overrides: Partial<Employee> = {}): Employee {
  return Object.assign(new Employee(), {
    id: "emp-001",
    employeeCode: "EMP-001",
    name: "Alice Johnson",
    email: "alice@example.com",
    department: "Engineering",
    hcmEmployeeId: "HCM-EMP-001",
    locationId: "LOC-001",
    isActive: true,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  });
}

function makeBalance(overrides: Partial<LeaveBalance> = {}): LeaveBalance {
  const b = Object.assign(new LeaveBalance(), {
    id: "bal-001",
    employeeId: "emp-001",
    locationId: "LOC-001",
    leaveType: "ANNUAL" as any,
    totalDays: 21,
    usedDays: 5,
    pendingDays: 0,
    hcmLastSyncedAt: new Date(),
    version: 1,
    ...overrides,
  });
  return b;
}

function makeRequest(overrides: Partial<LeaveRequest> = {}): LeaveRequest {
  return Object.assign(new LeaveRequest(), {
    id: "req-001",
    employeeId: "emp-001",
    locationId: "LOC-001",
    leaveType: "ANNUAL" as any,
    startDate: "2026-06-01",
    endDate: "2026-06-05",
    daysRequested: 5,
    status: "PENDING" as any,
    reason: "Vacation",
    hcmSyncStatus: "PENDING" as any,
    hcmRetryCount: 0,
    idempotencyKey: null,
    approvedBy: null,
    approvedAt: null,
    rejectedReason: null,
    hcmSubmissionId: null,
    hcmSyncError: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  });
}

function makeHcmBalanceResponse(available = 16) {
  return {
    hcmEmployeeId: "HCM-EMP-001",
    locationId: "LOC-001",
    balances: [
      {
        leaveType: "ANNUAL",
        totalDays: 21,
        usedDays: 21 - available,
        availableDays: available,
      },
    ],
    asOf: new Date().toISOString(),
  };
}

// ─── Mock Repository factory ──────────────────────────────────────────────────

function mockRepo<T>(): jest.Mocked<Repository<T>> {
  return {
    findOne: jest.fn(),
    findOneOrFail: jest.fn(),
    find: jest.fn(),
    save: jest.fn(),
    create: jest.fn(),
    createQueryBuilder: jest.fn(),
  } as any;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("TimeOffService", () => {
  let service: TimeOffService;
  let employeeRepo: jest.Mocked<Repository<Employee>>;
  let balanceRepo: jest.Mocked<Repository<LeaveBalance>>;
  let requestRepo: jest.Mocked<Repository<LeaveRequest>>;
  let hcmService: jest.Mocked<HcmIntegrationService>;
  let dataSource: jest.Mocked<DataSource>;

  beforeEach(async () => {
    employeeRepo = mockRepo<Employee>();
    balanceRepo = mockRepo<LeaveBalance>();
    requestRepo = mockRepo<LeaveRequest>();
    hcmService = {
      fetchBalance: jest.fn(),
      submitLeave: jest.fn(),
      fetchBatchSync: jest.fn(),
    } as any;

    // dataSource.transaction executes the callback synchronously with a mock manager
    const managerMock = {
      findOneOrFail: jest.fn(),
      findOne: jest.fn(),
      save: jest.fn(),
      create: jest.fn((entity: any, data: any) =>
        Object.assign(new entity(), data),
      ),
    };
    dataSource = {
      transaction: jest.fn().mockImplementation((cb) => cb(managerMock)),
    } as any;
    (dataSource as any)._manager = managerMock;

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TimeOffService,
        { provide: getRepositoryToken(Employee), useValue: employeeRepo },
        { provide: getRepositoryToken(LeaveBalance), useValue: balanceRepo },
        { provide: getRepositoryToken(LeaveRequest), useValue: requestRepo },
        { provide: HcmIntegrationService, useValue: hcmService },
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn().mockImplementation((key: string, def: any) => {
              const cfg: Record<string, any> = {
                "balance.staleThresholdMs": 900_000,
                "balance.maxAcceptableStaleMs": 3_600_000,
              };
              return cfg[key] ?? def;
            }),
          },
        },
        { provide: DataSource, useValue: dataSource },
      ],
    }).compile();

    service = module.get<TimeOffService>(TimeOffService);
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // calculateBusinessDays
  // ─────────────────────────────────────────────────────────────────────────────
  describe("calculateBusinessDays", () => {
    it("counts weekdays correctly for a Mon–Fri week", () => {
      expect(service.calculateBusinessDays("2026-06-01", "2026-06-05")).toBe(5);
    });

    it("excludes Saturday and Sunday", () => {
      // Mon to next Mon (7 days, 5 business)
      expect(service.calculateBusinessDays("2026-06-01", "2026-06-07")).toBe(5);
    });

    it("returns 0 when start is after end", () => {
      expect(service.calculateBusinessDays("2026-06-05", "2026-06-01")).toBe(0);
    });

    it("returns 1 for a single weekday", () => {
      expect(service.calculateBusinessDays("2026-06-01", "2026-06-01")).toBe(1);
    });

    it("returns 0 for a weekend-only range", () => {
      expect(service.calculateBusinessDays("2026-06-06", "2026-06-07")).toBe(0); // Sat–Sun
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // createRequest
  // ─────────────────────────────────────────────────────────────────────────────
  describe("createRequest", () => {
    const dto = {
      employeeId: "emp-001",
      leaveType: "ANNUAL",
      startDate: "2026-06-01",
      endDate: "2026-06-05",
      reason: "Test vacation",
    };

    function setupHappyPath(availableDays = 16) {
      const employee = makeEmployee();
      const balance = makeBalance({
        totalDays: 21,
        usedDays: 5,
        pendingDays: 0,
      });
      const createdRequest = makeRequest();

      employeeRepo.findOne.mockResolvedValue(employee);
      hcmService.fetchBalance.mockResolvedValue(
        makeHcmBalanceResponse(availableDays),
      );
      balanceRepo.save.mockResolvedValue(balance);
      balanceRepo.findOne.mockResolvedValue(balance);

      // Query builder for overlap check — returns null (no overlap)
      (requestRepo.createQueryBuilder as jest.Mock).mockReturnValue({
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        getOne: jest.fn().mockResolvedValue(null),
      });

      // transaction mock
      const mgr = (dataSource as any)._manager;
      mgr.findOneOrFail.mockResolvedValue(balance);
      mgr.save.mockImplementation((_entity: any, val: any) =>
        Promise.resolve(val ?? balance),
      );
      mgr.create.mockImplementation((_entity: any, data: any) => ({
        ...createdRequest,
        ...data,
      }));

      return { employee, balance, createdRequest };
    }

    it("creates a leave request and reserves pending days", async () => {
      const { balance } = setupHappyPath();
      const mgr = (dataSource as any)._manager;
      const savedRequest = makeRequest();
      mgr.save
        .mockResolvedValueOnce(balance) // saving balance
        .mockResolvedValueOnce(savedRequest); // saving request

      const result = await service.createRequest(dto);
      expect(result).toBeDefined();
      expect(mgr.save).toHaveBeenCalledTimes(2);
    });

    it("returns existing request on idempotency key match", async () => {
      const existing = makeRequest({ idempotencyKey: "idem-key-123" });
      requestRepo.findOne.mockResolvedValue(existing);

      const result = await service.createRequest({
        ...dto,
        idempotencyKey: "idem-key-123",
      });
      expect(result.id).toBe(existing.id);
      // Should not call HCM or create transaction
      expect(hcmService.fetchBalance).not.toHaveBeenCalled();
    });

    it("throws NotFoundException for unknown employee", async () => {
      employeeRepo.findOne.mockResolvedValue(null);
      requestRepo.findOne.mockResolvedValue(null); // no idempotency match

      await expect(service.createRequest(dto)).rejects.toThrow(
        NotFoundException,
      );
    });

    it("throws BadRequestException when leave spans zero business days", async () => {
      setupHappyPath();
      requestRepo.findOne.mockResolvedValue(null);

      await expect(
        service.createRequest({
          ...dto,
          startDate: "2026-06-06",
          endDate: "2026-06-07",
        }), // weekend
      ).rejects.toThrow(BadRequestException);
    });

    // ── Insufficient balance ───────────────────────────────────────────────────
    it("throws BadRequestException when available balance is insufficient", async () => {
      const employee = makeEmployee();
      // totalDays=21, usedDays=19, pendingDays=1 → available=1; request is 5 days
      const balance = makeBalance({
        totalDays: 21,
        usedDays: 19,
        pendingDays: 1,
      });

      employeeRepo.findOne.mockResolvedValue(employee);
      requestRepo.findOne.mockResolvedValue(null);
      hcmService.fetchBalance.mockResolvedValue(makeHcmBalanceResponse(1));
      // updateLocalBalancesFromHcm uses balanceRepo.findOne + save
      balanceRepo.findOne.mockResolvedValue(balance);
      balanceRepo.save.mockResolvedValue(balance);

      (requestRepo.createQueryBuilder as jest.Mock).mockReturnValue({
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        getOne: jest.fn().mockResolvedValue(null),
      });

      // The transactional check sees available=1, requested=5 → BadRequest
      const mgr = (dataSource as any)._manager;
      mgr.findOneOrFail.mockResolvedValue(balance);

      // Requesting 5 days with only 1 available
      await expect(service.createRequest({ ...dto })).rejects.toThrow(
        BadRequestException,
      );
    });

    // ── Overlapping dates ──────────────────────────────────────────────────────
    it("throws ConflictException on overlapping dates with an existing PENDING request", async () => {
      const employee = makeEmployee();
      employeeRepo.findOne.mockResolvedValue(employee);
      requestRepo.findOne.mockResolvedValue(null); // no idempotency match

      hcmService.fetchBalance.mockResolvedValue(makeHcmBalanceResponse(16));

      // Overlap query returns an existing request
      (requestRepo.createQueryBuilder as jest.Mock).mockReturnValue({
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        getOne: jest
          .fn()
          .mockResolvedValue(makeRequest({ status: "PENDING" as any })),
      });

      await expect(service.createRequest(dto)).rejects.toThrow(
        ConflictException,
      );
    });

    // ── HCM failure with fresh cache fallback ──────────────────────────────────
    it("uses cached balance when HCM is down and cache is fresh", async () => {
      const employee = makeEmployee();
      const freshBalance = makeBalance({
        totalDays: 21,
        usedDays: 5,
        pendingDays: 0,
        hcmLastSyncedAt: new Date(Date.now() - 5 * 60_000), // 5 min ago
      });

      employeeRepo.findOne.mockResolvedValue(employee);
      requestRepo.findOne.mockResolvedValue(null);
      hcmService.fetchBalance.mockRejectedValue(
        new ServiceUnavailableException("HCM down"),
      );
      balanceRepo.findOne.mockResolvedValue(freshBalance);

      (requestRepo.createQueryBuilder as jest.Mock).mockReturnValue({
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        getOne: jest.fn().mockResolvedValue(null),
      });

      const mgr = (dataSource as any)._manager;
      mgr.findOneOrFail.mockResolvedValue(freshBalance);
      const savedRequest = makeRequest();
      mgr.save
        .mockResolvedValueOnce(freshBalance)
        .mockResolvedValueOnce(savedRequest);
      mgr.create.mockReturnValue(savedRequest);

      const result = await service.createRequest(dto);
      expect(result).toBeDefined();
    });

    // ── HCM failure with stale cache ────────────────────────────────────────────
    it("throws ServiceUnavailableException when HCM down and cache is too stale", async () => {
      const employee = makeEmployee();
      const staleBalance = makeBalance({
        hcmLastSyncedAt: new Date(Date.now() - 2 * 3_600_000), // 2 hours ago (stale)
      });

      employeeRepo.findOne.mockResolvedValue(employee);
      requestRepo.findOne.mockResolvedValue(null);
      hcmService.fetchBalance.mockRejectedValue(
        new ServiceUnavailableException("HCM down"),
      );
      balanceRepo.findOne.mockResolvedValue(staleBalance);

      (requestRepo.createQueryBuilder as jest.Mock).mockReturnValue({
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        getOne: jest.fn().mockResolvedValue(null),
      });

      await expect(service.createRequest(dto)).rejects.toThrow(
        ServiceUnavailableException,
      );
    });

    // ── HCM failure with no cache at all ─────────────────────────────────────
    it("throws ServiceUnavailableException when HCM down and no local cache exists", async () => {
      const employee = makeEmployee();
      employeeRepo.findOne.mockResolvedValue(employee);
      requestRepo.findOne.mockResolvedValue(null);
      hcmService.fetchBalance.mockRejectedValue(
        new ServiceUnavailableException("HCM down"),
      );
      balanceRepo.findOne.mockResolvedValue(null); // no cache

      (requestRepo.createQueryBuilder as jest.Mock).mockReturnValue({
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        getOne: jest.fn().mockResolvedValue(null),
      });

      await expect(service.createRequest(dto)).rejects.toThrow(
        ServiceUnavailableException,
      );
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // processApproval
  // ─────────────────────────────────────────────────────────────────────────────
  describe("processApproval — APPROVE", () => {
    const approveDto = { action: "APPROVE" as const, approverId: "mgr-001" };

    function setupApproval(availableInHcm = 16) {
      const employee = makeEmployee();
      const request = makeRequest({ employee, status: "PENDING" as any });
      const balance = makeBalance({
        totalDays: 21,
        usedDays: 5,
        pendingDays: 5,
      });

      requestRepo.findOne.mockResolvedValue(request);
      hcmService.fetchBalance.mockResolvedValue(
        makeHcmBalanceResponse(availableInHcm),
      );

      // "other pending" query returns 0
      (requestRepo.createQueryBuilder as jest.Mock).mockReturnValue({
        select: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        getRawOne: jest.fn().mockResolvedValue({ total: "0" }),
      });

      const mgr = (dataSource as any)._manager;
      mgr.findOneOrFail.mockResolvedValue(balance);
      mgr.save.mockImplementation((_entity: any, val: any) =>
        Promise.resolve(val),
      );

      hcmService.submitLeave.mockResolvedValue({
        submissionId: "HCM-SUBM-001",
        status: "ACCEPTED",
        message: "Accepted",
        processedAt: new Date().toISOString(),
      });
      requestRepo.save.mockImplementation((val: any) => Promise.resolve(val));

      return { employee, request, balance };
    }

    it("approves the request and deducts balance", async () => {
      const { request } = setupApproval();
      const result = await service.processApproval("req-001", approveDto);

      expect(result.status).toBe("APPROVED");
      expect(result.approvedBy).toBe("mgr-001");
    });

    it("submits to HCM and marks SYNCED after approval", async () => {
      setupApproval();
      const result = await service.processApproval("req-001", approveDto);
      expect(result.hcmSyncStatus).toBe("SYNCED");
      expect(result.hcmSubmissionId).toBe("HCM-SUBM-001");
    });

    it("marks hcmSyncStatus=FAILED when HCM submission fails post-approval", async () => {
      setupApproval();
      hcmService.submitLeave.mockRejectedValue(
        new ServiceUnavailableException("HCM down"),
      );

      const result = await service.processApproval("req-001", approveDto);
      // Approval itself should succeed
      expect(result.status).toBe("APPROVED");
      // But HCM submission should be marked for retry
      expect(result.hcmSyncStatus).toBe("FAILED");
    });

    it("throws 503 when HCM is down during mandatory balance fetch", async () => {
      const request = makeRequest({
        employee: makeEmployee(),
        status: "PENDING" as any,
      });
      requestRepo.findOne.mockResolvedValue(request);
      hcmService.fetchBalance.mockRejectedValue(
        new ServiceUnavailableException("HCM down"),
      );

      await expect(
        service.processApproval("req-001", approveDto),
      ).rejects.toThrow(ServiceUnavailableException);
    });

    it("throws BadRequestException when HCM balance is insufficient at approval time", async () => {
      const employee = makeEmployee();
      // Employee used 20/21 days in HCM, requesting 5 more
      const request = makeRequest({
        employee,
        status: "PENDING" as any,
        daysRequested: 5,
      });
      requestRepo.findOne.mockResolvedValue(request);
      hcmService.fetchBalance.mockResolvedValue(makeHcmBalanceResponse(1)); // only 1 day left

      (requestRepo.createQueryBuilder as jest.Mock).mockReturnValue({
        select: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        getRawOne: jest.fn().mockResolvedValue({ total: "0" }),
      });

      await expect(
        service.processApproval("req-001", approveDto),
      ).rejects.toThrow(BadRequestException);
    });

    it("throws NotFoundException for non-existent request", async () => {
      requestRepo.findOne.mockResolvedValue(null);
      await expect(
        service.processApproval("ghost-id", approveDto),
      ).rejects.toThrow(NotFoundException);
    });

    it("throws BadRequestException when request is already approved", async () => {
      const request = makeRequest({
        status: "APPROVED" as any,
        employee: makeEmployee(),
      });
      requestRepo.findOne.mockResolvedValue(request);

      await expect(
        service.processApproval("req-001", approveDto),
      ).rejects.toThrow(BadRequestException);
    });

    // ── Out-of-sync balance (HCM lower than our cache) ─────────────────────────
    it("uses HCM balance (not cache) when HCM returns lower balance than cached", async () => {
      const employee = makeEmployee();
      // Our cache says 16 available, but HCM says only 3
      const request = makeRequest({
        employee,
        status: "PENDING" as any,
        daysRequested: 5,
      });
      requestRepo.findOne.mockResolvedValue(request);
      hcmService.fetchBalance.mockResolvedValue(makeHcmBalanceResponse(3)); // HCM: only 3 available

      (requestRepo.createQueryBuilder as jest.Mock).mockReturnValue({
        select: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        getRawOne: jest.fn().mockResolvedValue({ total: "0" }),
      });

      // Should fail because HCM has 3 but we need 5
      await expect(
        service.processApproval("req-001", approveDto),
      ).rejects.toThrow(BadRequestException);
    });

    // ── Race condition: other pending requests eat into balance ───────────────
    it("accounts for other pending requests when computing effective balance", async () => {
      const employee = makeEmployee();
      // HCM available: 6. Other pending: 4. Effective: 2. Requested: 5 → FAIL
      const request = makeRequest({
        employee,
        status: "PENDING" as any,
        daysRequested: 5,
      });
      requestRepo.findOne.mockResolvedValue(request);
      hcmService.fetchBalance.mockResolvedValue(makeHcmBalanceResponse(6));

      (requestRepo.createQueryBuilder as jest.Mock).mockReturnValue({
        select: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        getRawOne: jest.fn().mockResolvedValue({ total: "4" }), // 4 other pending days
      });

      await expect(
        service.processApproval("req-001", approveDto),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe("processApproval — REJECT", () => {
    it("rejects a pending request and releases pending days", async () => {
      const employee = makeEmployee();
      const request = makeRequest({
        employee,
        status: "PENDING" as any,
        daysRequested: 5,
      });
      const balance = makeBalance({ pendingDays: 5 });

      requestRepo.findOne.mockResolvedValue(request);

      const mgr = (dataSource as any)._manager;
      mgr.findOneOrFail.mockResolvedValue(balance);
      mgr.save.mockImplementation((_entity: any, val: any) =>
        Promise.resolve(val),
      );

      const result = await service.processApproval("req-001", {
        action: "REJECT",
        approverId: "mgr-001",
        rejectedReason: "Team understaffed",
      });

      expect(result.status).toBe("REJECTED");
      // pendingDays should have been decremented in the transaction
      expect(mgr.save).toHaveBeenCalled();
    });

    it("throws BadRequestException when rejectedReason is missing", async () => {
      const employee = makeEmployee();
      const request = makeRequest({ employee, status: "PENDING" as any });
      requestRepo.findOne.mockResolvedValue(request);

      await expect(
        service.processApproval("req-001", {
          action: "REJECT",
          approverId: "mgr-001",
        }),
      ).rejects.toThrow(BadRequestException);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // getBalance
  // ─────────────────────────────────────────────────────────────────────────────
  describe("getBalance", () => {
    it("returns HCM balance and updates local cache when HCM is available", async () => {
      const employee = makeEmployee();
      employeeRepo.findOne.mockResolvedValue(employee);
      hcmService.fetchBalance.mockResolvedValue(makeHcmBalanceResponse(16));
      balanceRepo.findOne.mockResolvedValue(makeBalance());
      balanceRepo.save.mockResolvedValue(makeBalance());
      balanceRepo.find.mockResolvedValue([makeBalance()]);

      const result = await service.getBalance("emp-001");
      expect(result.source).toBe("HCM");
      expect(result.balances).toHaveLength(1);
    });

    it("falls back to cached balance when HCM is unavailable", async () => {
      const employee = makeEmployee();
      employeeRepo.findOne.mockResolvedValue(employee);
      hcmService.fetchBalance.mockRejectedValue(
        new ServiceUnavailableException("HCM down"),
      );
      balanceRepo.find.mockResolvedValue([makeBalance()]);

      const result = await service.getBalance("emp-001");
      expect(result.source).toBe("CACHE");
    });

    it("throws NotFoundException for unknown employee", async () => {
      employeeRepo.findOne.mockResolvedValue(null);
      await expect(service.getBalance("ghost")).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // getHistory
  // ─────────────────────────────────────────────────────────────────────────────
  describe("getHistory", () => {
    it("returns paginated history", async () => {
      const employee = makeEmployee();
      employeeRepo.findOne.mockResolvedValue(employee);

      const qb = {
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        skip: jest.fn().mockReturnThis(),
        take: jest.fn().mockReturnThis(),
        getManyAndCount: jest.fn().mockResolvedValue([[makeRequest()], 1]),
      };
      (requestRepo.createQueryBuilder as jest.Mock).mockReturnValue(qb);

      const result = await service.getHistory("emp-001", {
        page: 1,
        limit: 20,
      });
      expect(result.total).toBe(1);
      expect(result.data).toHaveLength(1);
    });

    it("throws NotFoundException for unknown employee", async () => {
      employeeRepo.findOne.mockResolvedValue(null);
      await expect(service.getHistory("ghost", {})).rejects.toThrow(
        NotFoundException,
      );
    });
  });
});
