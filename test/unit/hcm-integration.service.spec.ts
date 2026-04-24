import { HttpService } from "@nestjs/axios";
import { ServiceUnavailableException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Test, TestingModule } from "@nestjs/testing";
import { of, throwError } from "rxjs";
import { HcmIntegrationService } from "../../src/hcm/hcm-integration.service";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function mockHttpResponse(data: any) {
  return of({
    data,
    status: 200,
    statusText: "OK",
    headers: {},
    config: {} as any,
  });
}

function mockHttpError(status: number, message = "error") {
  const err = new Error(message) as any;
  err.response = { status };
  return throwError(() => err);
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("HcmIntegrationService", () => {
  let service: HcmIntegrationService;
  let httpService: jest.Mocked<HttpService>;

  const mockConfig = {
    get: jest.fn().mockImplementation((key: string, def: any) => {
      const cfg: Record<string, any> = {
        "hcm.baseUrl": "http://localhost:3000/mock-hcm",
        "hcm.apiKey": "test-key",
        "hcm.timeoutMs": 1000,
        "hcm.maxRetries": 2,
        "hcm.retryBaseDelayMs": 10, // short for tests
        "hcm.retryMaxDelayMs": 50,
      };
      return cfg[key] ?? def;
    }),
  };

  beforeEach(async () => {
    httpService = {
      get: jest.fn(),
      post: jest.fn(),
    } as any;

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        HcmIntegrationService,
        { provide: HttpService, useValue: httpService },
        { provide: ConfigService, useValue: mockConfig },
      ],
    }).compile();

    service = module.get<HcmIntegrationService>(HcmIntegrationService);
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // fetchBalance
  // ─────────────────────────────────────────────────────────────────────────────
  describe("fetchBalance", () => {
    const balanceResponse = {
      hcmEmployeeId: "HCM-001",
      balances: [
        { leaveType: "ANNUAL", totalDays: 21, usedDays: 5, availableDays: 16 },
      ],
      asOf: new Date().toISOString(),
    };

    it("returns balance on successful HCM call", async () => {
      httpService.get.mockReturnValue(mockHttpResponse(balanceResponse) as any);
      const result = await service.fetchBalance("HCM-001");
      expect(result.hcmEmployeeId).toBe("HCM-001");
      expect(result.balances).toHaveLength(1);
    });

    it("retries on 500 errors and eventually succeeds", async () => {
      httpService.get
        .mockReturnValueOnce(mockHttpError(500, "Internal Server Error") as any)
        .mockReturnValue(mockHttpResponse(balanceResponse) as any);

      const result = await service.fetchBalance("HCM-001");
      expect(result.hcmEmployeeId).toBe("HCM-001");
      expect(httpService.get).toHaveBeenCalledTimes(2);
    });

    it("throws ServiceUnavailableException after all retries exhausted", async () => {
      httpService.get.mockReturnValue(mockHttpError(500, "Server down") as any);

      await expect(service.fetchBalance("HCM-001")).rejects.toThrow(
        ServiceUnavailableException,
      );
      // maxRetries = 2
      expect(httpService.get).toHaveBeenCalledTimes(2);
    });

    it("does NOT retry on 4xx client errors", async () => {
      httpService.get.mockReturnValueOnce(
        mockHttpError(404, "Not Found") as any,
      );

      await expect(service.fetchBalance("HCM-999")).rejects.toThrow(
        ServiceUnavailableException,
      );
      // Should fail on first attempt without retry
      expect(httpService.get).toHaveBeenCalledTimes(1);
    });

    it("includes x-api-key header in requests", async () => {
      httpService.get.mockReturnValue(mockHttpResponse(balanceResponse) as any);
      await service.fetchBalance("HCM-001");
      expect(httpService.get).toHaveBeenCalledWith(
        expect.stringContaining("/balance/HCM-001"),
        expect.objectContaining({
          headers: expect.objectContaining({ "x-api-key": "test-key" }),
        }),
      );
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // submitLeave
  // ─────────────────────────────────────────────────────────────────────────────
  describe("submitLeave", () => {
    const submitDto = {
      hcmEmployeeId: "HCM-001",
      locationId: "LOC-001",
      leaveType: "ANNUAL",
      startDate: "2026-06-01",
      endDate: "2026-06-05",
      daysRequested: 5,
      idempotencyKey: "req-uuid-001",
    };

    const acceptedResponse = {
      submissionId: "HCM-SUBM-001",
      status: "ACCEPTED",
      message: "OK",
      processedAt: new Date().toISOString(),
    };

    it("submits leave and returns acceptance", async () => {
      httpService.post.mockReturnValue(
        mockHttpResponse(acceptedResponse) as any,
      );
      const result = await service.submitLeave(submitDto);
      expect(result.status).toBe("ACCEPTED");
      expect(result.submissionId).toBe("HCM-SUBM-001");
    });

    it("retries on network error", async () => {
      httpService.post
        .mockReturnValueOnce(mockHttpError(503, "Service Unavailable") as any)
        .mockReturnValue(mockHttpResponse(acceptedResponse) as any);

      const result = await service.submitLeave(submitDto);
      expect(result.status).toBe("ACCEPTED");
      expect(httpService.post).toHaveBeenCalledTimes(2);
    });

    it("throws ServiceUnavailableException after max retries", async () => {
      httpService.post.mockReturnValue(mockHttpError(500) as any);
      await expect(service.submitLeave(submitDto)).rejects.toThrow(
        ServiceUnavailableException,
      );
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // fetchBatchSync
  // ─────────────────────────────────────────────────────────────────────────────
  describe("fetchBatchSync", () => {
    it("returns batch sync data", async () => {
      const batchData = {
        records: [{ hcmEmployeeId: "HCM-001", balances: [] }],
        totalCount: 1,
        generatedAt: new Date().toISOString(),
      };
      httpService.get.mockReturnValue(mockHttpResponse(batchData) as any);
      const result = await service.fetchBatchSync();
      expect(result.totalCount).toBe(1);
    });

    it("throws ServiceUnavailableException on failure", async () => {
      httpService.get.mockReturnValue(mockHttpError(500) as any);
      await expect(service.fetchBatchSync()).rejects.toThrow(
        ServiceUnavailableException,
      );
    });
  });
});
