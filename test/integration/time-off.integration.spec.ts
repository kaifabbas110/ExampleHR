// Use in-memory SQLite so tests never touch the real database
process.env.DB_PATH = ":memory:";
process.env.MOCK_HCM_FAILURE_RATE = "0";
process.env.MOCK_HCM_MIN_DELAY_MS = "0";
process.env.MOCK_HCM_MAX_DELAY_MS = "0";

import { HttpService } from "@nestjs/axios";
import { INestApplication, ValidationPipe } from "@nestjs/common";
import { Test, TestingModule } from "@nestjs/testing";
import { of } from "rxjs";
import * as request from "supertest";

import { AppModule } from "../../src/app.module";
import { AllExceptionsFilter } from "../../src/common/filters/all-exceptions.filter";

// ─── Helper: stub axios response ────────────────────────────────────────────────
function axiosResponse(data: any) {
  return of({
    data,
    status: 200,
    statusText: "OK",
    headers: {},
    config: {} as any,
  });
}

// ─── Integration Test Suite ──────────────────────────────────────────────────────

describe("Time-Off Integration Tests (in-memory SQLite)", () => {
  let app: INestApplication;
  let httpService: jest.Mocked<HttpService>;
  let employeeId: string;

  // HCM balance used throughout — 21 total, 5 used, 16 available
  const hcmBalanceResponse = {
    hcmEmployeeId: "HCM-EMP-001",
    locationId: "LOC-001",
    balances: [
      { leaveType: "ANNUAL", totalDays: 21, usedDays: 5, availableDays: 16 },
      { leaveType: "SICK", totalDays: 10, usedDays: 0, availableDays: 10 },
    ],
    asOf: new Date().toISOString(),
  };

  beforeAll(async () => {
    const mockHttpService = {
      get: jest.fn(),
      post: jest.fn(),
    };

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(HttpService)
      .useValue(mockHttpService)
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
    await app.init();

    httpService = moduleFixture.get<HttpService>(
      HttpService,
    ) as jest.Mocked<HttpService>;
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    jest.clearAllMocks();
    httpService.get.mockReturnValue(axiosResponse(hcmBalanceResponse) as any);
    httpService.post.mockReturnValue(
      axiosResponse({
        submissionId: "HCM-SUBM-001",
        status: "ACCEPTED",
        message: "Accepted",
        processedAt: new Date().toISOString(),
      }) as any,
    );
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Setup: create an employee
  // ─────────────────────────────────────────────────────────────────────────────
  describe("Employee setup", () => {
    it("POST /employees creates a new employee with zero-balance records", async () => {
      const res = await request(app.getHttpServer())
        .post("/employees")
        .send({
          employeeCode: "EMP-TEST-001",
          name: "Integration Test User",
          email: "integration@readyon.test",
          department: "QA",
          hcmEmployeeId: "HCM-EMP-001",
          locationId: "LOC-001",
        })
        .expect(201);

      expect(res.body.id).toBeDefined();
      expect(res.body.employeeCode).toBe("EMP-TEST-001");
      employeeId = res.body.id;
    });

    it("POST /employees returns 409 for duplicate employeeCode", async () => {
      await request(app.getHttpServer())
        .post("/employees")
        .send({
          employeeCode: "EMP-TEST-001",
          name: "Duplicate",
          email: "dup@readyon.test",
          department: "QA",
          hcmEmployeeId: "HCM-EMP-001",
          locationId: "LOC-001",
        })
        .expect(409);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Balance retrieval
  // ─────────────────────────────────────────────────────────────────────────────
  describe("GET /time-off/balance", () => {
    it("returns HCM balance for a known employee", async () => {
      const res = await request(app.getHttpServer())
        .get("/time-off/balance")
        .query({ employeeId })
        .expect(200);

      expect(res.body.source).toBe("HCM");
      expect(res.body.balances).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ leaveType: "ANNUAL", availableDays: 16 }),
        ]),
      );
    });

    it("returns 404 for unknown employeeId", async () => {
      await request(app.getHttpServer())
        .get("/time-off/balance")
        .query({ employeeId: "non-existent-id" })
        .expect(404);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Create leave requests
  // ─────────────────────────────────────────────────────────────────────────────
  describe("POST /time-off/request", () => {
    let requestId: string;

    it("creates a valid ANNUAL leave request", async () => {
      const res = await request(app.getHttpServer())
        .post("/time-off/request")
        .send({
          employeeId,
          leaveType: "ANNUAL",
          startDate: "2026-07-01",
          endDate: "2026-07-03",
          reason: "Integration test vacation",
        })
        .expect(201);

      expect(res.body.id).toBeDefined();
      expect(res.body.status).toBe("PENDING");
      expect(res.body.daysRequested).toBeGreaterThan(0);
      requestId = res.body.id;
    });

    it("returns 409 for overlapping leave request", async () => {
      await request(app.getHttpServer())
        .post("/time-off/request")
        .send({
          employeeId,
          leaveType: "ANNUAL",
          startDate: "2026-07-01", // overlaps with previous request
          endDate: "2026-07-02",
          reason: "Duplicate",
        })
        .expect(409);
    });

    it("returns same request on idempotency key replay", async () => {
      const idempotencyKey = "unique-key-12345";

      const firstRes = await request(app.getHttpServer())
        .post("/time-off/request")
        .send({
          employeeId,
          leaveType: "SICK",
          startDate: "2026-08-03",
          endDate: "2026-08-03",
          reason: "Sick day",
          idempotencyKey,
        })
        .expect(201);

      // Replay same idempotency key
      const secondRes = await request(app.getHttpServer())
        .post("/time-off/request")
        .send({
          employeeId,
          leaveType: "SICK",
          startDate: "2026-08-03",
          endDate: "2026-08-03",
          reason: "Sick day",
          idempotencyKey,
        })
        .expect(201);

      expect(secondRes.body.id).toBe(firstRes.body.id);
    });

    it("returns 400 for invalid date range (end before start)", async () => {
      await request(app.getHttpServer())
        .post("/time-off/request")
        .send({
          employeeId,
          leaveType: "ANNUAL",
          startDate: "2026-07-10",
          endDate: "2026-07-05", // before start
          reason: "Invalid",
        })
        .expect(400);
    });

    it("returns 400 for unknown leave type", async () => {
      await request(app.getHttpServer())
        .post("/time-off/request")
        .send({
          employeeId,
          leaveType: "HOLIDAY", // not a valid type
          startDate: "2026-09-01",
          endDate: "2026-09-02",
        })
        .expect(400);
    });

    // ── Approve the first request ─────────────────────────────────────────────
    describe("PUT /time-off/approve/:id", () => {
      it("approves a pending request", async () => {
        const res = await request(app.getHttpServer())
          .put(`/time-off/approve/${requestId}`)
          .send({ action: "APPROVE", approverId: "manager-001" })
          .expect(200);

        expect(res.body.status).toBe("APPROVED");
        expect(res.body.approvedBy).toBe("manager-001");
        expect(res.body.hcmSyncStatus).toBe("SYNCED");
      });

      it("returns 400 when approving an already-approved request", async () => {
        await request(app.getHttpServer())
          .put(`/time-off/approve/${requestId}`)
          .send({ action: "APPROVE", approverId: "manager-001" })
          .expect(400);
      });

      it("returns 404 for non-existent request ID", async () => {
        await request(app.getHttpServer())
          .put("/time-off/approve/ghost-id-12345")
          .send({ action: "APPROVE", approverId: "manager-001" })
          .expect(404);
      });
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Rejection flow
  // ─────────────────────────────────────────────────────────────────────────────
  describe("Rejection flow", () => {
    it("rejects a pending request and releases pending days", async () => {
      // Create another request to reject
      const createRes = await request(app.getHttpServer())
        .post("/time-off/request")
        .send({
          employeeId,
          leaveType: "ANNUAL",
          startDate: "2026-10-01",
          endDate: "2026-10-03",
          reason: "To be rejected",
        })
        .expect(201);

      const rejectRes = await request(app.getHttpServer())
        .put(`/time-off/approve/${createRes.body.id}`)
        .send({
          action: "REJECT",
          approverId: "manager-001",
          rejectedReason: "Team is too busy",
        })
        .expect(200);

      expect(rejectRes.body.status).toBe("REJECTED");
      expect(rejectRes.body.rejectedReason).toBe("Team is too busy");
    });

    it("returns 400 when REJECT action has no rejectedReason", async () => {
      const createRes = await request(app.getHttpServer())
        .post("/time-off/request")
        .send({
          employeeId,
          leaveType: "ANNUAL",
          startDate: "2026-11-02",
          endDate: "2026-11-02",
          reason: "Another request",
        })
        .expect(201);

      await request(app.getHttpServer())
        .put(`/time-off/approve/${createRes.body.id}`)
        .send({ action: "REJECT", approverId: "manager-001" }) // no rejectedReason
        .expect(400);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Leave history
  // ─────────────────────────────────────────────────────────────────────────────
  describe("GET /time-off/history", () => {
    it("returns paginated history", async () => {
      const res = await request(app.getHttpServer())
        .get("/time-off/history")
        .query({ employeeId, page: 1, limit: 10 })
        .expect(200);

      expect(res.body.total).toBeGreaterThan(0);
      expect(res.body.data).toBeInstanceOf(Array);
      expect(res.body.page).toBe(1);
    });

    it("filters by status", async () => {
      const res = await request(app.getHttpServer())
        .get("/time-off/history")
        .query({ employeeId, status: "APPROVED" })
        .expect(200);

      expect(res.body.data.every((r: any) => r.status === "APPROVED")).toBe(
        true,
      );
    });

    it("returns 404 for unknown employeeId", async () => {
      await request(app.getHttpServer())
        .get("/time-off/history")
        .query({ employeeId: "non-existent" })
        .expect(404);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Insufficient balance
  // ─────────────────────────────────────────────────────────────────────────────
  describe("Insufficient balance", () => {
    it("returns 400 when employee has insufficient leave balance", async () => {
      // Mock HCM to say only 1 day available
      httpService.get.mockReturnValue(
        axiosResponse({
          hcmEmployeeId: "HCM-EMP-001",
          locationId: "LOC-001",
          balances: [
            {
              leaveType: "ANNUAL",
              totalDays: 21,
              usedDays: 20,
              availableDays: 1,
            },
          ],
          asOf: new Date().toISOString(),
        }) as any,
      );

      await request(app.getHttpServer())
        .post("/time-off/request")
        .send({
          employeeId,
          leaveType: "ANNUAL",
          startDate: "2026-12-01",
          endDate: "2026-12-10", // requesting 8 days, only 1 available
          reason: "Too many days",
        })
        .expect(400);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Sync endpoints
  // ─────────────────────────────────────────────────────────────────────────────
  describe("Sync", () => {
    it("POST /sync/hcm triggers sync and returns 202", async () => {
      httpService.get.mockReturnValue(
        axiosResponse({
          records: [
            {
              hcmEmployeeId: "HCM-EMP-001",
              locationId: "LOC-001",
              balances: hcmBalanceResponse.balances,
            },
          ],
          totalCount: 1,
          generatedAt: new Date().toISOString(),
        }) as any,
      );

      const res = await request(app.getHttpServer())
        .post("/sync/hcm")
        .send({ triggeredBy: "INTEGRATION_TEST" })
        .expect(202);

      expect(res.body.message).toContain("sync");
    });

    it("GET /sync/logs returns recent sync logs", async () => {
      const res = await request(app.getHttpServer())
        .get("/sync/logs")
        .query({ limit: 5 })
        .expect(200);

      expect(res.body).toBeInstanceOf(Array);
    });
  });
});
