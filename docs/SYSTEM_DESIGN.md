# System Design Document

# Time-Off Microservice — ReadyOn HR / ExampleHR

---

## 1. High-Level Architecture

```
┌─────────────────────────────────────────────────────────────────────────┐
│                         Client Applications                             │
│              (Employee Portal, Manager Dashboard, Mobile App)           │
└──────────────────────────────┬──────────────────────────────────────────┘
                               │ HTTPS
                               ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                          API Gateway                                    │
│              (Auth, Rate Limiting, TLS Termination)                     │
└──────────────────────────────┬──────────────────────────────────────────┘
                               │
                               ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                   ReadyOn Time-Off Microservice (NestJS)                │
│                                                                         │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  ┌────────────┐ │
│  │  TimeOff     │  │  Employees   │  │    Sync      │  │    HCM     │ │
│  │  Module      │  │  Module      │  │   Module     │  │ Integration│ │
│  │              │  │              │  │              │  │  Module    │ │
│  │ - Controller │  │ - Controller │  │ - Controller │  │            │ │
│  │ - Service    │  │ - Service    │  │ - Service    │  │ - Service  │ │
│  │ - DTOs       │  │ - DTOs       │  │ - Scheduler  │  │ - Mock Ctrl│ │
│  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘  └─────┬──────┘ │
│         │                 │                 │                │        │
│         └─────────────────┴────────┬────────┘                │        │
│                                    ▼                          │        │
│                      ┌─────────────────────────┐             │        │
│                      │   SQLite Database       │             │        │
│                      │   (TypeORM)             │             │        │
│                      │                         │             │        │
│                      │  - employees            │             │        │
│                      │  - leave_balances       │             │        │
│                      │  - leave_requests       │             │        │
│                      │  - sync_logs            │             │        │
│                      └─────────────────────────┘             │        │
│                                                               │        │
└───────────────────────────────────────────────────────────────┼────────┘
                                                                │ HTTP
                                                                ▼
                                              ┌─────────────────────────┐
                                              │   HCM External System   │
                                              │   (Source of Truth)     │
                                              │                         │
                                              │ GET  /balance/:empId    │
                                              │ POST /leave/submit      │
                                              │ GET  /sync/batch        │
                                              └─────────────────────────┘
```

---

## 2. Component Descriptions

### 2.1 TimeOff Module

Handles all leave lifecycle operations: submission, approval/rejection, history queries.

**Key Responsibilities:**

- Validate leave requests (dates, overlaps, balance)
- Coordinate with HCM Integration Service for balance verification
- Manage the `leave_requests` and `leave_balances` tables
- Enforce idempotency

### 2.2 Employees Module

Manages employee records that mirror what is in HCM.

**Key Responsibilities:**

- CRUD for employees
- Seed HCM employee IDs for cross-system lookups

### 2.3 Sync Module

Orchestrates background and manual synchronization between ExampleHR and HCM.

**Key Responsibilities:**

- Scheduled sync (cron, every 15 minutes)
- Manual sync trigger via API
- Retry failed HCM submissions
- Record sync history in `sync_logs`

### 2.4 HCM Integration Module

Abstraction layer for all communication with HCM.

**Key Responsibilities:**

- HTTP client for HCM REST API
- Retry with exponential backoff
- Circuit breaker (log failures; degrade gracefully)
- Mock HCM controller (simulates real HCM for dev/test)

---

## 3. Database Schema

### 3.1 Entity Relationship Diagram

```
employees
┌──────────────────────────┐
│ id (PK, UUID)            │
│ employee_code (UNIQUE)   │◄─────────────────────────┐
│ name                     │                          │
│ email (UNIQUE)           │                          │
│ department               │                          │
│ hcm_employee_id (UNIQUE) │                          │
│ is_active                │                          │
│ created_at               │                          │
│ updated_at               │                          │
└──────────┬───────────────┘                          │
           │ 1                                        │
           │                                          │
           │ N                                        │
┌──────────▼───────────────┐        ┌─────────────────┴────────┐
│ leave_balances           │        │ leave_requests           │
│                          │        │                          │
│ id (PK, UUID)            │        │ id (PK, UUID)            │
│ employee_id (FK)         │        │ employee_id (FK)         │
│ leave_type               │        │ leave_type               │
│ total_days               │        │ start_date               │
│ used_days                │        │ end_date                 │
│ pending_days             │        │ days_requested           │
│ hcm_last_synced_at       │        │ status                   │
│ version                  │        │ reason                   │
│ created_at               │        │ approved_by              │
│ updated_at               │        │ approved_at              │
│                          │        │ rejected_reason          │
│ UNIQUE(employee_id,      │        │ hcm_submission_id        │
│        leave_type)       │        │ hcm_sync_status          │
└──────────────────────────┘        │ idempotency_key (UNIQUE) │
                                    │ created_at               │
                                    │ updated_at               │
                                    └──────────────────────────┘

sync_logs
┌──────────────────────────┐
│ id (PK, UUID)            │
│ sync_type                │
│ status                   │
│ records_processed        │
│ records_failed           │
│ error_message            │
│ triggered_by             │
│ started_at               │
│ completed_at             │
└──────────────────────────┘
```

### 3.2 Indexes

| Table          | Index                                 | Purpose                 |
| -------------- | ------------------------------------- | ----------------------- |
| employees      | `employee_code`                       | Unique lookup           |
| employees      | `hcm_employee_id`                     | Cross-system lookup     |
| leave_balances | `(employee_id, leave_type)`           | Balance query           |
| leave_requests | `employee_id`                         | History query           |
| leave_requests | `(employee_id, status)`               | Pending/approved filter |
| leave_requests | `(employee_id, start_date, end_date)` | Overlap check           |
| leave_requests | `idempotency_key`                     | Duplicate detection     |
| leave_requests | `hcm_sync_status`                     | Failed retry queue      |

---

## 4. Flow Diagrams

### 4.1 Leave Request Submission Flow

```
Client                  TimeOffService           HcmIntegrationService     SQLite
  │                         │                           │                     │
  │ POST /time-off/request  │                           │                     │
  │────────────────────────►│                           │                     │
  │                         │ validate DTO              │                     │
  │                         │ check idempotency ────────────────────────────►│
  │                         │◄──────────────────────────────────────────────►│
  │                         │                           │                     │
  │                         │ check overlapping dates ──────────────────────►│
  │                         │◄──────────────────────────────────────────────►│
  │                         │                           │                     │
  │                         │ fetchBalance(hcmEmpId) ──►│                     │
  │                         │                           │ GET /balance/:id    │
  │                         │                           │ (with retry)        │
  │                         │◄─────── balance ──────────│                     │
  │                         │                           │                     │
  │                         │ BEGIN TRANSACTION ────────────────────────────►│
  │                         │ re-check available balance                      │
  │                         │ pendingDays += requested ─────────────────────►│
  │                         │ INSERT leave_request ──────────────────────────►│
  │                         │ COMMIT ────────────────────────────────────────►│
  │                         │◄──────────────────────────────────────────────►│
  │◄── 201 Created ─────────│                           │                     │
```

### 4.2 Leave Approval Flow (Strong Consistency)

```
Approver                TimeOffService          HcmIntegrationService        SQLite
   │                        │                          │                        │
   │ PUT /approve/:id        │                          │                        │
   │───────────────────────►│                          │                        │
   │                        │ fetch request (PENDING) ──────────────────────►  │
   │                        │◄──────────────────────────────────────────────── │
   │                        │                          │                        │
   │                        │ MANDATORY HCM fetch ────►│                        │
   │                        │                          │ GET /balance/:id       │
   │                        │                          │ (max 3 retries)        │
   │                        │                          │──────────────────────► │
   │                        │                          │        HCM             │
   │                        │◄──── hcmBalance ─────────│                        │
   │                        │                          │                        │
   │                        │  [HCM down?] ───── 503 Service Unavailable ──────►│
   │                        │                                                   │
   │                        │ BEGIN TRANSACTION ─────────────────────────────► │
   │                        │ UPDATE leave_balances                             │
   │                        │   (match HCM, deduct days, bump version) ───────►│
   │                        │ UPDATE leave_request status=APPROVED ───────────►│
   │                        │                                                   │
   │                        │ submitLeave to HCM ─────►│                        │
   │                        │                          │ POST /leave/submit     │
   │                        │◄──── submissionId ───────│                        │
   │                        │                          │                        │
   │                        │ [HCM submit fail?]                                │
   │                        │ UPDATE hcmSyncStatus=FAILED (still COMMIT) ─────►│
   │                        │ COMMIT ─────────────────────────────────────────►│
   │◄── 200 Approved ───────│                          │                        │
```

### 4.3 Background Sync Flow

```
Scheduler (cron)         SyncService            HcmIntegrationService       SQLite
     │                       │                          │                       │
     │ [every 15 min]        │                          │                       │
     │──────────────────────►│                          │                       │
     │                       │ INSERT sync_log (RUNNING) ─────────────────────►│
     │                       │ fetchAllEmployees ─────────────────────────────►│
     │                       │◄─────────────────────────────────────────────── │
     │                       │                          │                       │
     │                       │ for each employee:        │                       │
     │                       │   fetchBalance(hcmEmpId) ►│                       │
     │                       │◄─── balance ─────────────│                       │
     │                       │   UPDATE leave_balances ──────────────────────► │
     │                       │                          │                       │
     │                       │ retryFailedSubmissions:   │                       │
     │                       │   query hcmSyncStatus=FAILED ─────────────────►│
     │                       │◄──── failed requests ───────────────────────── │
     │                       │   submitLeave(each) ─────►│                       │
     │                       │                          │                       │
     │                       │ UPDATE sync_log (SUCCESS) ─────────────────────►│
```

---

## 5. API Design

### 5.1 POST /time-off/request

**Submit a new leave request.**

**Request:**

```json
{
  "employeeId": "emp-uuid",
  "leaveType": "ANNUAL",
  "startDate": "2026-05-01",
  "endDate": "2026-05-05",
  "reason": "Family vacation",
  "idempotencyKey": "client-generated-uuid"
}
```

**Response 201:**

```json
{
  "id": "req-uuid",
  "employeeId": "emp-uuid",
  "leaveType": "ANNUAL",
  "startDate": "2026-05-01",
  "endDate": "2026-05-05",
  "daysRequested": 3,
  "status": "PENDING",
  "reason": "Family vacation",
  "hcmSyncStatus": "PENDING",
  "createdAt": "2026-04-24T10:00:00Z"
}
```

**Error Responses:**

- `400 Bad Request` — validation failure, insufficient balance, invalid dates
- `409 Conflict` — overlapping leave request exists
- `404 Not Found` — employee not found
- `503 Service Unavailable` — HCM down AND local cache is stale

---

### 5.2 GET /time-off/balance?employeeId=:id

**Get leave balances for an employee.**

**Response 200:**

```json
{
  "employeeId": "emp-uuid",
  "balances": [
    {
      "leaveType": "ANNUAL",
      "totalDays": 21,
      "usedDays": 5,
      "pendingDays": 3,
      "availableDays": 13,
      "hcmLastSyncedAt": "2026-04-24T09:45:00Z",
      "isStale": false
    }
  ],
  "source": "HCM",
  "fetchedAt": "2026-04-24T10:00:00Z"
}
```

**Notes:**

- `source` is `"HCM"` when live data was fetched, `"CACHE"` when fallback was used.
- `isStale: true` when cache age > `STALE_THRESHOLD_MINUTES` (default 15).

---

### 5.3 GET /time-off/history?employeeId=:id&status=APPROVED&year=2026&page=1&limit=20

**Paginated leave history.**

**Response 200:**

```json
{
  "data": [
    {
      "id": "req-uuid",
      "leaveType": "ANNUAL",
      "startDate": "2026-05-01",
      "endDate": "2026-05-05",
      "daysRequested": 3,
      "status": "APPROVED",
      "reason": "Family vacation",
      "approvedBy": "mgr-uuid",
      "approvedAt": "2026-04-25T08:00:00Z",
      "hcmSyncStatus": "SYNCED",
      "hcmSubmissionId": "HCM-12345"
    }
  ],
  "total": 5,
  "page": 1,
  "limit": 20
}
```

---

### 5.4 PUT /time-off/approve/:id

**Approve or reject a pending leave request.**

**Request:**

```json
{
  "action": "APPROVE",
  "approverId": "mgr-uuid",
  "rejectedReason": null
}
```

**Response 200:**

```json
{
  "id": "req-uuid",
  "status": "APPROVED",
  "approvedBy": "mgr-uuid",
  "approvedAt": "2026-04-25T08:00:00Z",
  "hcmSyncStatus": "SYNCED",
  "hcmSubmissionId": "HCM-12345",
  "balanceAfterApproval": {
    "leaveType": "ANNUAL",
    "availableDays": 13
  }
}
```

**Error Responses:**

- `400` — already approved/rejected; insufficient balance
- `404` — request not found
- `409` — concurrent update conflict (retry)
- `503` — HCM unavailable (mandatory live check failed)

---

### 5.5 POST /sync/hcm

**Trigger a manual full sync from HCM.**

**Request:** (empty body or specify employee)

```json
{ "employeeId": "emp-uuid" }
```

**Response 202:**

```json
{
  "syncLogId": "sync-uuid",
  "status": "RUNNING",
  "triggeredBy": "MANUAL",
  "startedAt": "2026-04-24T10:00:00Z"
}
```

---

## 6. Consistency Guarantees Summary

| Operation       | Consistency Level        | HCM Required                 | Fallback                      |
| --------------- | ------------------------ | ---------------------------- | ----------------------------- |
| View Balance    | Eventual                 | Try live, fall back to cache | Cache with `isStale` flag     |
| Submit Request  | Bounded staleness (1 hr) | Try live, fall back if fresh | Block if > 1 hr stale         |
| Approve Request | Strong                   | Mandatory live fetch         | 503 if HCM down               |
| Reject Request  | None                     | Not required                 | N/A                           |
| Background Sync | Eventual                 | Required (skipped if down)   | Log failure, retry next cycle |

---

## 7. Mock HCM Service Design

The mock HCM simulates a realistic external HCM system with:

- **Configurable failure rate** (default 20%)
- **Configurable response delay** (50–500ms random)
- **In-memory data store** (seeded with 5 employees)
- **Idempotent leave submissions** (keyed by `idempotencyKey`)
- **Data drift simulation** (occasionally returns a slightly different balance)

### Mock HCM Endpoints

| Method | Path                        | Description                  |
| ------ | --------------------------- | ---------------------------- |
| GET    | /mock-hcm/balance/:hcmEmpId | Fetch employee balance       |
| POST   | /mock-hcm/leave/submit      | Submit approved leave        |
| GET    | /mock-hcm/sync/batch        | Batch export all balances    |
| POST   | /mock-hcm/admin/reset       | Reset to seed data (testing) |
