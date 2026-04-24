# Technical Requirements Document (TRD)

# Time-Off Microservice — ReadyOn HR / ExampleHR

**Version:** 1.0.0  
**Date:** 2026-04-24  
**Author:** Senior Backend Architect  
**Status:** Approved for Implementation

---

## Table of Contents

1. [Problem Definition](#1-problem-definition)
2. [Assumptions](#2-assumptions)
3. [Constraints](#3-constraints)
4. [Functional Requirements](#4-functional-requirements)
5. [Non-Functional Requirements](#5-non-functional-requirements)
6. [Architecture Decisions](#6-architecture-decisions)
7. [Data Consistency Strategy](#7-data-consistency-strategy)
8. [Failure Scenarios & Mitigations](#8-failure-scenarios--mitigations)
9. [Retry & Reconciliation Mechanisms](#9-retry--reconciliation-mechanisms)
10. [API Contract](#10-api-contract)
11. [Trade-off Analysis](#11-trade-off-analysis)
12. [Security Considerations](#12-security-considerations)

---

## 1. Problem Definition

### 1.1 Context

ExampleHR (ReadyOn) is an HR platform where employees submit and track leave requests. **HCM (Human Capital Management)** is the enterprise-wide source of truth for all employee leave balances. Multiple systems — payroll, attendance, direct HCM entries — can modify leave balances in HCM independently of ExampleHR.

### 1.2 Core Problem

ExampleHR must:

- Display accurate leave balances to employees
- Accept leave requests without over-committing available days
- Approve leave only against verified current balances
- Stay consistent with HCM even when HCM is unreliable or temporarily unavailable

### 1.3 Key Tensions

| Tension                     | Description                                                   |
| --------------------------- | ------------------------------------------------------------- |
| Freshness vs. Availability  | Requiring a live HCM call on every read degrades availability |
| Consistency vs. Performance | Strong consistency requires synchronous HCM calls at approval |
| Simplicity vs. Reliability  | Handling HCM failures adds significant complexity             |
| Latency vs. Correctness     | Stale cache is fast but risks over-approval                   |

---

## 2. Assumptions

1. **HCM has a REST API** exposing: balance query, leave submission, and batch export endpoints.
2. **HCM is eventually consistent** within itself — a submitted leave may not reflect in balance immediately (propagation lag up to ~30 seconds).
3. **HCM availability SLA is ~95%** — we must tolerate up to 5% downtime gracefully.
4. **Business days only** are counted for leave duration; weekends are excluded. Public holidays are out-of-scope for v1.
5. **ExampleHR is the only system routing leave requests** through this microservice — direct HCM entries by HR admins are synced via batch.
6. **Employees cannot modify or cancel their own approved leave** without manager action (admin feature, out-of-scope for v1).
7. **All monetary/day values** are stored with 2 decimal precision (half-day leaves supported).
8. **Authentication/Authorization** is handled upstream (API gateway) and not within this service; requests arrive pre-authenticated with `X-Employee-ID` header.
9. **A single NestJS process** handles all requests; horizontal scaling is future work.
10. **Leave types** are: ANNUAL, SICK, EMERGENCY, MATERNITY, PATERNITY, UNPAID.

---

## 3. Constraints

| Constraint            | Detail                                                                        |
| --------------------- | ----------------------------------------------------------------------------- |
| Framework             | NestJS (TypeScript)                                                           |
| Database              | SQLite (via TypeORM + better-sqlite3)                                         |
| External System       | HCM REST API (unreliable, must handle failures)                               |
| Deployment            | Single-process; no message broker for v1                                      |
| Transaction Isolation | SQLite provides SERIALIZABLE isolation (WAL mode)                             |
| No row-level locks    | SQLite uses database-level write locks; optimistic locking via version column |

---

## 4. Functional Requirements

### FR-1: Leave Request Submission

- Employee can submit a leave request specifying: `leaveType`, `startDate`, `endDate`, `reason`.
- System validates dates (start <= end, future dates only).
- System calculates business days.
- System checks for **overlapping requests** (PENDING or APPROVED) for the same employee.
- System verifies **sufficient available balance** using freshest possible data.
- Request is created in `PENDING` state; the requested days are reserved as `pendingDays`.
- An **idempotency key** may be provided; duplicate submissions with the same key return the original request.

### FR-2: Balance Query

- Returns the employee's leave balances per type.
- Attempts a live HCM fetch; falls back to cached data with a staleness indicator.
- Reports `isStale: true` and `lastSyncedAt` when cached data is used.

### FR-3: Leave Approval

- Authorized approver sets status to `APPROVED` or `REJECTED`.
- **Approval flow mandates a fresh HCM balance check** — cached data is NOT acceptable.
- System recalculates effective availability: `HCM.available − other_pending_days`.
- If sufficient: deduct balance, submit to HCM, commit atomically.
- If HCM is down during approval: reject the approval attempt with `503 HCM Unavailable`.
- If HCM submission fails post-deduction: mark `hcmSyncStatus = FAILED` and queue for retry.

### FR-4: Leave History

- Returns paginated list of leave requests for an employee.
- Supports filter by `status`, `leaveType`, `year`.

### FR-5: Manual HCM Sync

- Authorized admin can trigger a manual balance sync from HCM.
- Sync updates all employee balances in the local database.
- Sync logs are recorded with start time, completion time, records processed, and failures.

### FR-6: Scheduled Sync

- Automatic sync runs every 15 minutes (configurable via env).
- Individual employee sync failures do not abort the entire batch.

### FR-7: Seed Data

- Development/testing seed script populates mock employees and balances.

---

## 5. Non-Functional Requirements

| NFR            | Requirement                                                                          |
| -------------- | ------------------------------------------------------------------------------------ |
| Availability   | Service must return balance responses within 2s; degrade gracefully when HCM is down |
| Durability     | No approved leave request must be lost even if HCM submission fails                  |
| Idempotency    | Leave requests with the same idempotency key must not create duplicates              |
| Auditability   | All HCM sync operations must be logged in `sync_logs`                                |
| Observability  | All requests and HCM calls must be logged with correlation IDs                       |
| Correctness    | Zero tolerance for approving leave with insufficient balance                         |
| Recoverability | Failed HCM submissions must be retried on next sync cycle                            |

---

## 6. Architecture Decisions

### ADR-1: Hybrid Consistency Model

**Decision:** Use **strong consistency at approval time**, eventual consistency at request creation.

**Rationale:**

- Approval is the point of commitment — incorrect approval has business impact (employee works when they shouldn't have leave).
- Request creation is a soft reservation — the pending flag reserves capacity but doesn't commit.
- Mandating a live HCM call on every balance read would make the service brittle.

**Consequence:** Approval may occasionally reject when HCM is down. This is the correct trade-off: better to temporarily block approvals than to over-commit leave.

---

### ADR-2: Local SQLite as Write-Through Cache

**Decision:** Maintain a local `leave_balances` table as a **write-through cache** of HCM data.

**Rationale:**

- Decouples ExampleHR availability from HCM availability.
- Allows balance reads to be served locally when HCM is unreachable.
- Sync process keeps the cache fresh.

**Consequence:** Balance data may be stale between sync cycles (max 15 minutes + HCM propagation lag). Staleness is surfaced to clients via `isStale` flag.

---

### ADR-3: Optimistic Locking for Balance Updates

**Decision:** Use TypeORM's `@VersionColumn()` for optimistic locking on `leave_balances`.

**Rationale:**

- SQLite does not support row-level pessimistic locks.
- Concurrent updates to the same balance row will result in an `OptimisticLockVersionMismatchError`, which we catch and retry (max 3 attempts).
- SQLite's serializable isolation ensures only one writer succeeds per database write cycle.

---

### ADR-4: HCM Submission Retry Queue (In-Process)

**Decision:** Failed HCM submissions are marked `hcmSyncStatus = FAILED` and retried on the next sync cycle rather than using an external message broker.

**Rationale:**

- Keeps the architecture simple for v1.
- SQLite durably stores the pending retry.
- Max acceptable delay for HCM submission is ~15 minutes (one sync cycle).

**Future Work:** Replace with a proper message queue (e.g., BullMQ, SQS) for higher reliability.

---

### ADR-5: Mock HCM as Internal Module

**Decision:** The mock HCM runs as an internal NestJS module on `/mock-hcm/*` prefix.

**Rationale:** Simplifies the demo without requiring a second process. The `HcmIntegrationService` calls it via HTTP (same configurable base URL), so swapping to a real HCM requires only an env variable change.

---

## 7. Data Consistency Strategy

### 7.1 Balance Lifecycle

```
HCM Source of Truth
        │
        ├─ Batch Sync (every 15 min) ──────► local leave_balances (cache)
        │                                         │
        └─ Live Fetch (on request/approval) ──────┘
                                                  │
                              Employee submits request
                                                  │
                              pendingDays += requestedDays (soft reserve)
                                                  │
                              Manager approves request
                                                  │
                    ┌─── Fresh HCM fetch (mandatory) ───────────────┐
                    │                                               │
               HCM available                                 HCM unavailable
                    │                                               │
          Check: HCM.avail - otherPending >= requested        Reject 503
                    │
          Update: usedDays += requested
                  pendingDays -= requested
                  Submit to HCM
                    │
               APPROVED ✓
```

### 7.2 Stale Data Policy

| Operation       | Acceptable Staleness | Behavior if Stale                    |
| --------------- | -------------------- | ------------------------------------ |
| View Balance    | 15 minutes           | Show with `isStale: true`            |
| Submit Request  | 60 minutes           | Show with warning; block if > 60 min |
| Approve Request | 0 (live required)    | Block with 503 if HCM down           |
| Reject Request  | 0 staleness needed   | No balance check required            |

### 7.3 Conflict Resolution

When HCM returns a balance lower than our cached value:

1. **Update** our local cache to match HCM (HCM wins).
2. If the new HCM balance is insufficient for any PENDING requests, those requests stay PENDING (not auto-rejected).
3. At approval time, the fresh check will surface the insufficiency and the approver will be notified.
4. This avoids auto-rejecting requests that might have been legitimate at creation time.

### 7.4 Optimistic Lock Conflict Handling

If two concurrent approvals attempt to update the same employee's balance:

1. TypeORM throws `OptimisticLockVersionMismatchError`.
2. The service catches this, re-fetches the latest balance, and retries (up to 3 times).
3. After 3 failures, returns `409 Conflict` to the client.

---

## 8. Failure Scenarios & Mitigations

| Scenario                              | Impact                                  | Mitigation                                            |
| ------------------------------------- | --------------------------------------- | ----------------------------------------------------- |
| HCM API timeout during balance fetch  | Cannot verify balance                   | Use cached balance (if fresh); surface `isStale`      |
| HCM API down during approval          | Cannot approve                          | Return 503; cached data not accepted                  |
| HCM API down during request creation  | Cannot verify balance                   | Allow if cache < 60 min old; block otherwise          |
| HCM submission fails after approval   | Balance deducted locally but not in HCM | Mark `hcmSyncStatus = FAILED`; retry on next sync     |
| HCM returns lower balance than cached | Risk of over-approval                   | Update cache; fresh check at approval will catch it   |
| Concurrent approvals of same request  | Double-deduction                        | Transaction + optimistic lock prevents this           |
| Duplicate leave request               | Phantom requests                        | Idempotency key check; overlapping date check         |
| Network partition to HCM              | Extended unavailability                 | Service continues with cached data; approvals blocked |
| Database corruption                   | Service unavailable                     | SQLite WAL mode; regular backups (ops concern)        |
| Clock skew                            | Incorrect date calculations             | All dates normalized to UTC                           |

---

## 9. Retry & Reconciliation Mechanisms

### 9.1 HCM Call Retry Policy

```
Attempt 1 → wait 500ms → Attempt 2 → wait 1000ms → Attempt 3 → wait 2000ms → FAIL
```

- Max 3 attempts by default (configurable via `HCM_MAX_RETRIES`).
- Exponential backoff: `delay = min(500 × 2^(attempt-1), 5000)` ms.
- Timeout per attempt: 5 seconds (configurable via `HCM_TIMEOUT_MS`).
- Non-retryable errors (4xx): fail immediately without retry.

### 9.2 Failed HCM Submissions (Post-Approval)

1. Approval succeeds locally; request status = `APPROVED`.
2. HCM submission fails → `hcmSyncStatus = FAILED`, error stored.
3. Next sync cycle: query all requests where `hcmSyncStatus = FAILED`.
4. Retry submission for each failed record.
5. On success: `hcmSyncStatus = SYNCED`, `hcmSubmissionId` stored.
6. After 5 failed retries: alert (log `ERROR`); manual intervention required.

### 9.3 Balance Reconciliation

- Every 15 minutes: fetch all employee balances from HCM.
- Compare with local cache.
- Update local cache to match HCM.
- Log discrepancies.
- If drift exceeds threshold (configurable), log a `WARN`.

---

## 10. API Contract (Summary)

| Method | Path                  | Description                       |
| ------ | --------------------- | --------------------------------- |
| POST   | /time-off/request     | Submit leave request              |
| GET    | /time-off/balance     | Get leave balances                |
| GET    | /time-off/history     | Get leave request history         |
| PUT    | /time-off/approve/:id | Approve or reject a leave request |
| POST   | /sync/hcm             | Trigger manual HCM sync           |
| GET    | /sync/logs            | Get sync history                  |
| POST   | /employees            | Create employee (admin)           |
| GET    | /employees/:id        | Get employee details              |

Full request/response schemas: see [SYSTEM_DESIGN.md](./SYSTEM_DESIGN.md).

---

## 11. Trade-off Analysis

### 11.1 Sync vs. Async Leave Submission to HCM

| Approach                                    | Pros                  | Cons                                      | Decision                      |
| ------------------------------------------- | --------------------- | ----------------------------------------- | ----------------------------- |
| **Synchronous** (submit to HCM at approval) | Immediate consistency | Approval blocked if HCM down              | ✅ Chosen — correctness first |
| **Asynchronous** (submit via queue)         | Decouples from HCM    | Risk of approval without HCM confirmation | Use for retry, not initial    |

### 11.2 Caching vs. Real-Time

| Approach                                      | Pros                                  | Cons                              | Decision            |
| --------------------------------------------- | ------------------------------------- | --------------------------------- | ------------------- |
| **Always live**                               | Maximum freshness                     | Service down if HCM down          | ❌ Too brittle      |
| **Always cached**                             | Fast, highly available                | Stale balances risk over-approval | ❌ Too inconsistent |
| **Hybrid** (live at approval, cached at read) | Balance of consistency + availability | Complexity                        | ✅ Chosen           |

### 11.3 Optimistic vs. Pessimistic Locking

| Approach        | Pros                              | Cons                    | Decision         |
| --------------- | --------------------------------- | ----------------------- | ---------------- |
| **Pessimistic** | No retries needed                 | Not supported in SQLite | ❌ Not available |
| **Optimistic**  | Works with SQLite; low contention | Requires retry logic    | ✅ Chosen        |

---

## 12. Security Considerations

- **Input Validation:** All DTOs validated via `class-validator`; no raw SQL queries (TypeORM ORM layer).
- **SQL Injection:** TypeORM parameterized queries prevent injection.
- **Authentication:** Assumed handled upstream; service trusts `X-Employee-ID` header (production would verify JWT).
- **Rate Limiting:** Not implemented in v1; recommended at API gateway.
- **Sensitive Data:** No PII stored beyond what is necessary; no passwords in this service.
- **Environment Secrets:** HCM API keys via environment variables; never hardcoded.
