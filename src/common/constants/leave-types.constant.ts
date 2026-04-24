export const LEAVE_TYPES = [
  "ANNUAL",
  "SICK",
  "EMERGENCY",
  "MATERNITY",
  "PATERNITY",
  "UNPAID",
] as const;

export type LeaveType = (typeof LEAVE_TYPES)[number];

export const LEAVE_REQUEST_STATUSES = [
  "PENDING",
  "APPROVED",
  "REJECTED",
  "CANCELLED",
] as const;
export type LeaveRequestStatus = (typeof LEAVE_REQUEST_STATUSES)[number];

export const HCM_SYNC_STATUSES = ["PENDING", "SYNCED", "FAILED"] as const;
export type HcmSyncStatus = (typeof HCM_SYNC_STATUSES)[number];

export const SYNC_TYPES = ["FULL", "INCREMENTAL", "MANUAL"] as const;
export type SyncType = (typeof SYNC_TYPES)[number];

export const SYNC_STATUSES = [
  "RUNNING",
  "SUCCESS",
  "FAILED",
  "PARTIAL",
] as const;
export type SyncStatus = (typeof SYNC_STATUSES)[number];
