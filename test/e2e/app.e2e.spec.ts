// Use in-memory SQLite so tests never touch the real database
process.env.DB_PATH = ":memory:";
process.env.MOCK_HCM_FAILURE_RATE = "0";
process.env.MOCK_HCM_MIN_DELAY_MS = "0";
process.env.MOCK_HCM_MAX_DELAY_MS = "0";

import { Test, TestingModule } from "@nestjs/testing";
import { INestApplication, ValidationPipe } from "@nestjs/common";
import { HttpService } from "@nestjs/axios";
import { of } from "rxjs";
import * as request from "supertest";
import { AppModule } from "../../src/app.module";
import { AllExceptionsFilter } from "../../src/common/filters/all-exceptions.filter";
import { LoggingInterceptor } from "../../src/common/interceptors/logging.interceptor";

function axiosResponse(data: any) {
  return of({
    data,
    status: 200,
    statusText: "OK",
    headers: {},
    config: {} as any,
  });
}

describe("App E2E Tests", () => {
  let app: INestApplication;
  let httpService: jest.Mocked<HttpService>;

  const hcmBalance = (hcmEmployeeId: string, available = 16) => ({
    hcmEmployeeId,
    locationId: "LOC-001",
    balances: [
      {
        leaveType: "ANNUAL",
        totalDays: 21,
        usedDays: 21 - available,
        availableDays: available,
      },
      { leaveType: "SICK", totalDays: 10, usedDays: 0, availableDays: 10 },
      { leaveType: "EMERGENCY", totalDays: 3, usedDays: 0, availableDays: 3 },
    ],
    asOf: new Date().toISOString(),
  });

  const hcmSubmitAccepted = () => ({
    submissionId: `HCM-SUBM-${Date.now()}`,
    status: "ACCEPTED",
    message: "Leave request accepted",
    processedAt: new Date().toISOString(),
  });

  beforeAll(async () => {
    const mockHttp = { get: jest.fn(), post: jest.fn() };

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(HttpService)
      .useValue(mockHttp)
      .compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    app.useGlobalFilters(new AllExceptionsFilter());
    app.useGlobalInterceptors(new LoggingInterceptor());
    await app.init();

    httpService = moduleFixture.get(HttpService);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    jest.clearAllMocks();
    httpService.get.mockReturnValue(
      axiosResponse(hcmBalance("HCM-E2E-001")) as any,
    );
    httpService.post.mockReturnValue(axiosResponse(hcmSubmitAccepted()) as any);
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Health check
  // ─────────────────────────────────────────────────────────────────────────────
  describe("GET /health (implicit via routing)", () => {
    it("returns 404 on an undefined route", async () => {
      await request(app.getHttpServer()).get("/nonexistent-route").expect(404);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Full end-to-end flow
  // ─────────────────────────────────────────────────────────────────────────────
  describe("Full lifecycle: create → request → approve", () => {
    let employeeId: string;
    let requestId: string;

    it("1. Creates an employee", async () => {
      const res = await request(app.getHttpServer())
        .post("/employees")
        .send({
          employeeCode: "E2E-EMP-001",
          name: "E2E Test Employee",
          email: "e2e@readyon.test",
          department: "Engineering",
          hcmEmployeeId: "HCM-E2E-001",
          locationId: "LOC-001",
        })
        .expect(201);

      employeeId = res.body.id;
      expect(employeeId).toBeDefined();
    });

    it("2. Retrieves HCM balance", async () => {
      const res = await request(app.getHttpServer())
        .get("/time-off/balance")
        .query({ employeeId })
        .expect(200);

      expect(res.body.source).toBe("HCM");
      expect(res.body.balances).toContainEqual(
        expect.objectContaining({ leaveType: "ANNUAL", availableDays: 16 }),
      );
    });

    it("3. Creates a leave request", async () => {
      const res = await request(app.getHttpServer())
        .post("/time-off/request")
        .send({
          employeeId,
          leaveType: "ANNUAL",
          startDate: "2026-07-14",
          endDate: "2026-07-16",
          reason: "E2E test vacation",
        })
        .expect(201);

      requestId = res.body.id;
      expect(res.body.status).toBe("PENDING");
      expect(res.body.daysRequested).toBe(3);
    });

    it("4. Gets leave history showing the pending request", async () => {
      const res = await request(app.getHttpServer())
        .get("/time-off/history")
        .query({ employeeId, status: "PENDING" })
        .expect(200);

      expect(res.body.data).toHaveLength(1);
      expect(res.body.data[0].id).toBe(requestId);
    });

    it("5. Approves the request", async () => {
      const res = await request(app.getHttpServer())
        .put(`/time-off/approve/${requestId}`)
        .send({ action: "APPROVE", approverId: "manager-e2e" })
        .expect(200);

      expect(res.body.status).toBe("APPROVED");
      expect(res.body.hcmSyncStatus).toBe("SYNCED");
    });

    it("6. Verifies balance is reduced after approval", async () => {
      // Mock HCM to reflect updated balance (3 more days used)
      httpService.get.mockReturnValue(
        axiosResponse(hcmBalance("HCM-E2E-001", 13)) as any, // 16 - 3 = 13
      );

      const res = await request(app.getHttpServer())
        .get("/time-off/balance")
        .query({ employeeId })
        .expect(200);

      expect(res.body.balances).toContainEqual(
        expect.objectContaining({ leaveType: "ANNUAL", availableDays: 13 }),
      );
    });

    it("7. History shows the approved request", async () => {
      const res = await request(app.getHttpServer())
        .get("/time-off/history")
        .query({ employeeId, status: "APPROVED" })
        .expect(200);

      expect(res.body.data).toHaveLength(1);
      expect(res.body.data[0].status).toBe("APPROVED");
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Mock HCM endpoints
  // ─────────────────────────────────────────────────────────────────────────────
  describe("Mock HCM endpoints", () => {
    it("POST /mock-hcm/admin/reset resets state", async () => {
      await request(app.getHttpServer())
        .post("/mock-hcm/admin/reset")
        .expect(200);
    });

    it("GET /mock-hcm/balance/:id returns balance from mock", async () => {
      const res = await request(app.getHttpServer())
        .get("/mock-hcm/balance/HCM-EMP-001")
        .expect(200);

      expect(res.body.hcmEmployeeId).toBe("HCM-EMP-001");
      expect(res.body.balances).toBeInstanceOf(Array);
    });

    it("POST /mock-hcm/leave/submit accepts a valid leave submission", async () => {
      const res = await request(app.getHttpServer())
        .post("/mock-hcm/leave/submit")
        .send({
          hcmEmployeeId: "HCM-EMP-001",
          locationId: "LOC-001",
          leaveType: "ANNUAL",
          startDate: "2026-07-01",
          endDate: "2026-07-02",
          daysRequested: 2,
          idempotencyKey: "mock-test-key",
        })
        .expect(201);

      expect(res.body.status).toMatch(/ACCEPTED|REJECTED/);
    });

    it("GET /mock-hcm/sync/batch returns batch sync data", async () => {
      const res = await request(app.getHttpServer())
        .get("/mock-hcm/sync/batch")
        .expect(200);

      expect(res.body.records).toBeInstanceOf(Array);
      expect(res.body.totalCount).toBeGreaterThan(0);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Input validation
  // ─────────────────────────────────────────────────────────────────────────────
  describe("Input validation", () => {
    it("rejects requests with extra fields (forbidNonWhitelisted)", async () => {
      await request(app.getHttpServer())
        .post("/employees")
        .send({
          employeeCode: "VAL-001",
          name: "Validation Test",
          email: "val@test.com",
          hcmEmployeeId: "HCM-VAL-001",
          locationId: "LOC-001",
          secretField: "should be rejected", // extra field
        })
        .expect(400);
    });

    it("rejects employee creation with invalid email", async () => {
      await request(app.getHttpServer())
        .post("/employees")
        .send({
          employeeCode: "VAL-002",
          name: "Bad Email",
          email: "not-an-email",
          hcmEmployeeId: "HCM-VAL-002",
        })
        .expect(400);
    });

    it("rejects leave request with missing required fields", async () => {
      await request(app.getHttpServer())
        .post("/time-off/request")
        .send({
          leaveType: "ANNUAL",
          startDate: "2026-07-01",
          // missing employeeId and endDate
        })
        .expect(400);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Correlation ID propagation
  // ─────────────────────────────────────────────────────────────────────────────
  describe("Correlation ID", () => {
    it("echoes x-correlation-id from request header", async () => {
      const correlationId = "test-correlation-id-xyz";
      const res = await request(app.getHttpServer())
        .get("/time-off/history")
        .set("x-correlation-id", correlationId)
        .query({ employeeId: "any" });

      // The response should include the correlation ID header
      expect(res.headers["x-correlation-id"]).toBe(correlationId);
    });

    it("generates a correlation ID when none is provided", async () => {
      const res = await request(app.getHttpServer())
        .get("/time-off/history")
        .query({ employeeId: "any" });
      expect(res.headers["x-correlation-id"]).toBeDefined();
      expect(res.headers["x-correlation-id"]).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      );
    });
  });
});
