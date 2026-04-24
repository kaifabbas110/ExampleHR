import { IsString, IsNumber, IsOptional } from "class-validator";

/** Balance record as returned by HCM */
export class HcmBalanceRecord {
  leaveType: string;
  totalDays: number;
  usedDays: number;
  /** availableDays = totalDays - usedDays (as reported by HCM) */
  availableDays: number;
}

/** Response from GET /mock-hcm/balance/:hcmEmployeeId */
export class HcmBalanceResponse {
  hcmEmployeeId: string;
  /** Location this balance response applies to */
  locationId: string;
  balances: HcmBalanceRecord[];
  /** ISO timestamp from HCM */
  asOf: string;
}

/** Request body for POST /mock-hcm/leave/submit */
export class HcmSubmitLeaveDto {
  @IsString()
  hcmEmployeeId: string;

  @IsString()
  locationId: string;

  @IsString()
  leaveType: string;

  @IsString()
  startDate: string;

  @IsString()
  endDate: string;

  @IsNumber()
  daysRequested: number;

  @IsOptional()
  @IsString()
  reason?: string;

  /** Client-generated idempotency key to prevent duplicate submissions */
  @IsOptional()
  @IsString()
  idempotencyKey?: string;
}

/** Response from POST /mock-hcm/leave/submit */
export class HcmSubmitLeaveResponse {
  submissionId: string;
  status: "ACCEPTED" | "REJECTED";
  message: string;
  processedAt: string;
}

/** Single record in the batch sync export */
export class HcmBatchSyncRecord {
  hcmEmployeeId: string;
  /** Location this record's balances apply to */
  locationId: string;
  balances: HcmBalanceRecord[];
}

/** Response from GET /mock-hcm/sync/batch */
export class HcmBatchSyncResponse {
  records: HcmBatchSyncRecord[];
  totalCount: number;
  generatedAt: string;
}
