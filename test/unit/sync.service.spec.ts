import { Test, TestingModule } from "@nestjs/testing";
import { getRepositoryToken } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import { SyncService } from "../../src/sync/sync.service";
import { Employee } from "../../src/entities/employee.entity";
import { LeaveBalance } from "../../src/entities/leave-balance.entity";
import { LeaveRequest } from "../../src/entities/leave-request.entity";
import { SyncLog } from "../../src/entities/sync-log.entity";
import { HcmIntegrationService } from "../../src/hcm/hcm-integration.service";
import { TimeOffService } from "../../src/time-off/time-off.service";
import { ServiceUnavailableException } from "@nestjs/common";

function mockRepo<T>() {
  return {
    find: jest.fn(),
    findOne: jest.fn(),
    findOneOrFail: jest.fn(),
    save: jest.fn(),
    create: jest.fn().mockImplementation((data: any) => data ?? {}),
    createQueryBuilder: jest.fn(),
  } as unknown as jest.Mocked<Repository<T>>;
}

function makeEmployee(hcmId = "HCM-001"): Employee {
  return Object.assign(new Employee(), {
    id: `emp-${hcmId}`,
    employeeCode: hcmId,
    hcmEmployeeId: hcmId,
    locationId: "LOC-001",
    isActive: true,
    name: "Test User",
    email: `${hcmId}@test.com`,
  });
}

function makeSyncLog(): SyncLog {
  return Object.assign(new SyncLog(), {
    id: "sync-001",
    syncType: "FULL" as any,
    status: "RUNNING" as any,
    recordsProcessed: 0,
    recordsFailed: 0,
    triggeredBy: "SCHEDULER",
    startedAt: new Date(),
    completedAt: null,
  });
}

describe("SyncService", () => {
  let service: SyncService;
  let employeeRepo: jest.Mocked<Repository<Employee>>;
  let syncLogRepo: jest.Mocked<Repository<SyncLog>>;
  let requestRepo: jest.Mocked<Repository<LeaveRequest>>;
  let hcmService: jest.Mocked<HcmIntegrationService>;
  let timeOffService: jest.Mocked<TimeOffService>;

  beforeEach(async () => {
    employeeRepo = mockRepo<Employee>();
    syncLogRepo = mockRepo<SyncLog>();
    requestRepo = mockRepo<LeaveRequest>();
    hcmService = {
      fetchBalance: jest.fn(),
      fetchBatchSync: jest.fn(),
      submitLeave: jest.fn(),
    } as any;
    timeOffService = {
      updateLocalBalancesFromHcm: jest.fn().mockResolvedValue([]),
    } as any;

    const log = makeSyncLog();
    syncLogRepo.create.mockReturnValue(log);
    syncLogRepo.save.mockResolvedValue(log);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SyncService,
        { provide: getRepositoryToken(Employee), useValue: employeeRepo },
        {
          provide: getRepositoryToken(LeaveBalance),
          useValue: mockRepo<LeaveBalance>(),
        },
        { provide: getRepositoryToken(LeaveRequest), useValue: requestRepo },
        { provide: getRepositoryToken(SyncLog), useValue: syncLogRepo },
        { provide: HcmIntegrationService, useValue: hcmService },
        { provide: TimeOffService, useValue: timeOffService },
      ],
    }).compile();

    service = module.get<SyncService>(SyncService);
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // runFullSync — batch path
  // ─────────────────────────────────────────────────────────────────────────────
  describe("runFullSync", () => {
    const batchResponse = {
      records: [
        {
          hcmEmployeeId: "HCM-001",
          locationId: "LOC-001",
          balances: [
            {
              leaveType: "ANNUAL",
              totalDays: 21,
              usedDays: 5,
              availableDays: 16,
            },
          ],
        },
        {
          hcmEmployeeId: "HCM-002",
          locationId: "LOC-001",
          balances: [
            {
              leaveType: "ANNUAL",
              totalDays: 21,
              usedDays: 10,
              availableDays: 11,
            },
          ],
        },
      ],
      totalCount: 2,
      generatedAt: new Date().toISOString(),
    };

    it("processes all batch records and returns SUCCESS status", async () => {
      hcmService.fetchBatchSync.mockResolvedValue(batchResponse);
      employeeRepo.findOne
        .mockResolvedValueOnce(makeEmployee("HCM-001"))
        .mockResolvedValueOnce(makeEmployee("HCM-002"));
      requestRepo.find.mockResolvedValue([]); // no failed submissions

      const result = await service.runFullSync("SCHEDULER");
      expect(result.status).toBe("SUCCESS");
      expect(result.recordsProcessed).toBe(2);
      expect(result.recordsFailed).toBe(0);
    });

    it("continues processing other employees when one fails", async () => {
      hcmService.fetchBatchSync.mockResolvedValue(batchResponse);
      employeeRepo.findOne.mockResolvedValueOnce(makeEmployee("HCM-001"));
      // Second employee found but update throws
      employeeRepo.findOne.mockResolvedValueOnce(makeEmployee("HCM-002"));
      timeOffService.updateLocalBalancesFromHcm
        .mockResolvedValueOnce([]) // HCM-001 succeeds
        .mockRejectedValueOnce(new Error("DB write error")); // HCM-002 fails

      requestRepo.find.mockResolvedValue([]);

      const result = await service.runFullSync();
      expect(result.status).toBe("PARTIAL");
      expect(result.recordsProcessed).toBe(1);
      expect(result.recordsFailed).toBe(1);
    });

    it("falls back to individual fetches when batch endpoint fails", async () => {
      hcmService.fetchBatchSync.mockRejectedValue(
        new ServiceUnavailableException("Batch unavailable"),
      );
      employeeRepo.find.mockResolvedValue([
        makeEmployee("HCM-001"),
        makeEmployee("HCM-002"),
      ]);
      hcmService.fetchBalance.mockResolvedValue({
        hcmEmployeeId: "HCM-001",
        locationId: "LOC-001",
        balances: [],
        asOf: new Date().toISOString(),
      });
      requestRepo.find.mockResolvedValue([]);

      const result = await service.runFullSync();
      expect(hcmService.fetchBalance).toHaveBeenCalledTimes(2);
      expect(result.recordsProcessed).toBe(2);
    });

    it("skips unknown HCM employee IDs", async () => {
      hcmService.fetchBatchSync.mockResolvedValue({
        ...batchResponse,
        records: [
          { hcmEmployeeId: "UNKNOWN-999", locationId: "LOC-001", balances: [] },
        ],
        totalCount: 1,
      });
      employeeRepo.findOne.mockResolvedValue(null); // not found
      requestRepo.find.mockResolvedValue([]);

      const result = await service.runFullSync();
      expect(result.recordsProcessed).toBe(0); // skipped, not failed
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Retry failed HCM submissions
  // ─────────────────────────────────────────────────────────────────────────────
  describe("retry failed HCM submissions", () => {
    it("retries FAILED submissions and marks SYNCED on success", async () => {
      const employee = makeEmployee("HCM-001");
      const failedRequest = Object.assign(new LeaveRequest(), {
        id: "req-001",
        employeeId: employee.id,
        employee,
        locationId: "LOC-001",
        leaveType: "ANNUAL" as any,
        startDate: "2026-06-01",
        endDate: "2026-06-05",
        daysRequested: 5,
        status: "APPROVED" as any,
        hcmSyncStatus: "FAILED" as any,
        hcmRetryCount: 0,
        reason: "Test",
        hcmSubmissionId: null,
        hcmSyncError: "Previous failure",
      });

      hcmService.fetchBatchSync.mockResolvedValue({
        records: [],
        totalCount: 0,
        generatedAt: "",
      });
      requestRepo.find.mockResolvedValue([failedRequest]);
      requestRepo.save.mockResolvedValue(failedRequest);

      hcmService.submitLeave.mockResolvedValue({
        submissionId: "HCM-SUBM-NEW",
        status: "ACCEPTED",
        message: "OK",
        processedAt: new Date().toISOString(),
      });

      await service.runFullSync();

      expect(failedRequest.hcmSyncStatus).toBe("SYNCED");
      expect(failedRequest.hcmSubmissionId).toBe("HCM-SUBM-NEW");
    });

    it("skips requests that have exceeded max retry attempts (5)", async () => {
      const employee = makeEmployee("HCM-001");
      const exhaustedRequest = Object.assign(new LeaveRequest(), {
        id: "req-exhausted",
        employee,
        hcmSyncStatus: "FAILED" as any,
        hcmRetryCount: 5, // already at max
        status: "APPROVED" as any,
      });

      hcmService.fetchBatchSync.mockResolvedValue({
        records: [],
        totalCount: 0,
        generatedAt: "",
      });
      requestRepo.find.mockResolvedValue([exhaustedRequest]);

      await service.runFullSync();

      // submitLeave should NOT have been called
      expect(hcmService.submitLeave).not.toHaveBeenCalled();
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // syncEmployee
  // ─────────────────────────────────────────────────────────────────────────────
  describe("syncEmployee", () => {
    it("syncs a single employee successfully", async () => {
      const employee = makeEmployee("HCM-001");
      employeeRepo.findOne.mockResolvedValue(employee);
      hcmService.fetchBalance.mockResolvedValue({
        hcmEmployeeId: "HCM-001",
        locationId: "LOC-001",
        balances: [
          {
            leaveType: "ANNUAL",
            totalDays: 21,
            usedDays: 5,
            availableDays: 16,
          },
        ],
        asOf: new Date().toISOString(),
      });

      const result = await service.syncEmployee(employee.id);
      expect(result.status).toBe("SUCCESS");
      expect(result.recordsProcessed).toBe(1);
    });

    it("returns FAILED status for unknown employee", async () => {
      employeeRepo.findOne.mockResolvedValue(null);
      const result = await service.syncEmployee("ghost-id");
      expect(result.status).toBe("FAILED");
    });
  });
});
