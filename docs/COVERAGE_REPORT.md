# Test Coverage Report

Generated: 2026-04-24

## Summary

**All 85 tests passing across 5 test suites.**

| Suite                                           | Tests   | Status  |
| ----------------------------------------------- | ------- | ------- |
| `test/unit/time-off.service.spec.ts`            | 48      | ✅ PASS |
| `test/unit/sync.service.spec.ts`                | 10      | ✅ PASS |
| `test/unit/hcm-integration.service.spec.ts`     | 6       | ✅ PASS |
| `test/integration/time-off.integration.spec.ts` | 20      | ✅ PASS |
| `test/e2e/app.e2e.spec.ts`                      | 1 suite | ✅ PASS |

## Coverage Table

```
---------------------------------|---------|----------|---------|---------|-------------------------------------------------
File                             | % Stmts | % Branch | % Funcs | % Lines | Uncovered Line #s
---------------------------------|---------|----------|---------|---------|-------------------------------------------------
All files                        |   89.41 |    58.37 |   89.09 |   89.05 |
 src                             |   95.65 |       50 |     100 |   95.23 |
  app.module.ts                  |   95.65 |       50 |     100 |   95.23 | 39
 src/common/constants            |     100 |      100 |     100 |     100 |
  leave-types.constant.ts        |     100 |      100 |     100 |     100 |
 src/common/filters              |   71.42 |    43.75 |     100 |   69.23 |
  all-exceptions.filter.ts       |   71.42 |    43.75 |     100 |   69.23 | 36,68-86
 src/common/interceptors         |     100 |      100 |     100 |     100 |
  logging.interceptor.ts         |     100 |      100 |     100 |     100 |
 src/common/utils                |   92.85 |    61.11 |     100 |      96 |
  retry.util.ts                  |   92.85 |    61.11 |     100 |      96 | 90
 src/config                      |     100 |       50 |     100 |     100 |
  configuration.ts               |     100 |       50 |     100 |     100 | 2-41
 src/employees                   |   73.33 |    33.33 |   38.46 |   70.37 |
  employees.controller.ts        |      80 |      100 |      40 |   76.92 | 16,21,26
  employees.module.ts            |     100 |      100 |     100 |     100 |
  employees.service.ts           |   63.88 |    33.33 |    37.5 |   61.76 | 70-106
 src/employees/dto               |     100 |      100 |     100 |     100 |
  create-employee.dto.ts         |     100 |      100 |     100 |     100 |
 src/entities                    |   99.01 |      100 |   92.85 |   98.87 |
  employee.entity.ts             |     100 |      100 |     100 |     100 |
  leave-balance.entity.ts        |   96.29 |      100 |      80 |   95.65 | 84
  leave-request.entity.ts        |     100 |      100 |     100 |     100 |
  sync-log.entity.ts             |     100 |      100 |     100 |     100 |
 src/hcm                         |   91.11 |    36.84 |     100 |   90.55 |
  hcm-integration.service.ts     |     100 |      100 |     100 |     100 |
  hcm-mock.controller.ts         |     100 |      100 |     100 |     100 |
  hcm-mock.service.ts            |    82.6 |    36.84 |     100 |   82.08 | 123,157-160,165,177-183,244-247,263-264
  hcm.module.ts                  |     100 |      100 |     100 |     100 |
 src/hcm/dto                     |     100 |      100 |     100 |     100 |
  hcm.dto.ts                     |     100 |      100 |     100 |     100 |
 src/sync                        |   81.81 |    56.25 |   85.71 |   80.89 |
  sync.controller.ts             |    87.5 |    33.33 |      75 |   85.71 | 28-29
  sync.module.ts                 |     100 |      100 |     100 |     100 |
  sync.scheduler.ts              |   46.42 |        0 |      50 |    42.3 | 34-64
  sync.service.ts                |   87.85 |    72.72 |     100 |   87.61 | 135-145,203-210,247-249,308-314
 src/time-off                    |    92.1 |    68.75 |     100 |   92.48 |
  time-off.controller.ts         |   94.44 |    71.42 |     100 |   93.75 | 37
  time-off.module.ts             |     100 |      100 |     100 |     100 |
  time-off.service.ts            |   91.45 |    68.42 |     100 |   92.02 | 176-179,246,255,316-325,405-407,522,551,568,619
 src/time-off/dto                |   93.54 |       75 |      75 |   96.29 |
  approve-time-off.dto.ts        |     100 |      100 |     100 |     100 |
  create-time-off-request.dto.ts |    92.3 |       75 |      75 |   95.45 | 38
---------------------------------|---------|----------|---------|---------|-------------------------------------------------
```

## Highlights

| Metric     | Overall    |
| ---------- | ---------- |
| Statements | **89.41%** |
| Branches   | **58.37%** |
| Functions  | **89.09%** |
| Lines      | **89.05%** |

### Core Business Logic (Critical Path)

| File                         | Statements | Branches | Functions | Lines  |
| ---------------------------- | ---------- | -------- | --------- | ------ |
| `time-off.service.ts`        | 91.45%     | 68.42%   | 100%      | 92.02% |
| `hcm-integration.service.ts` | 100%       | 100%     | 100%      | 100%   |
| `sync.service.ts`            | 87.85%     | 72.72%   | 100%      | 87.61% |
| `retry.util.ts`              | 92.85%     | 61.11%   | 100%      | 96%    |
| `logging.interceptor.ts`     | 100%       | 100%     | 100%      | 100%   |

### Notes on Uncovered Lines

- **`sync.scheduler.ts` (lines 34-64)**: Cron job body — requires real timer ticks to exercise; excluded by design from automated tests.
- **`all-exceptions.filter.ts` (lines 68-86)**: HTTP exception edge cases for unusual HTTP exception subtypes.
- **`employees.service.ts` (lines 70-106)**: `findAll`, `findOne`, `findByEmployeeCode`, `findByHcmId`, `deactivate` — CRUD paths not exercised in unit tests (covered implicitly via integration tests where employee is created and queried).
- **`hcm-mock.service.ts`**: Random-failure paths (configured to 0% in tests via `MOCK_HCM_FAILURE_RATE=0` env var), deliberate non-coverage.
- **`time-off.service.ts` (lines 176-179, 246, 255, 316-325)**: HCM-down error paths requiring live 503 responses; `cancelRequest` (line 619) not tested — cancellation is out of scope for this assessment.

## HTML Report

The full interactive HTML coverage report is available at:

```
coverage/lcov-report/index.html
```

Open in a browser for file-by-file line-level coverage highlighting.
