import {
  Entity,
  PrimaryColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  ManyToOne,
  JoinColumn,
  BeforeInsert,
  Index,
} from "typeorm";
import { v4 as uuidv4 } from "uuid";
import { Employee } from "./employee.entity";
import {
  LeaveType,
  LeaveRequestStatus,
  HcmSyncStatus,
} from "../common/constants/leave-types.constant";

@Entity("leave_requests")
@Index(["employeeId", "status"])
@Index(["employeeId", "startDate", "endDate"])
export class LeaveRequest {
  @PrimaryColumn("varchar", { length: 36 })
  id: string;

  @Column()
  employeeId: string;

  @ManyToOne(() => Employee, (employee) => employee.leaveRequests, {
    onDelete: "RESTRICT",
  })
  @JoinColumn({ name: "employeeId" })
  employee: Employee;

  @Column({ type: "varchar", length: 20 })
  leaveType: LeaveType;

  /** Location context for this leave request (e.g. "LOC-001") */
  @Column({ type: "varchar", length: 50 })
  locationId: string;

  /** ISO date string: YYYY-MM-DD */
  @Column({ type: "varchar", length: 10 })
  startDate: string;

  /** ISO date string: YYYY-MM-DD */
  @Column({ type: "varchar", length: 10 })
  endDate: string;

  /** Number of business days in the range */
  @Column({ type: "real" })
  daysRequested: number;

  @Column({ type: "varchar", length: 20, default: "PENDING" })
  status: LeaveRequestStatus;

  @Column({ type: "text", nullable: true })
  reason: string | null;

  /** UUID of the approver employee */
  @Column({ type: "varchar", length: 36, nullable: true })
  approvedBy: string | null;

  @Column({ type: "datetime", nullable: true })
  approvedAt: Date | null;

  /** Reason provided when rejecting or cancelling */
  @Column({ type: "text", nullable: true })
  rejectedReason: string | null;

  /** ID returned by HCM when the leave was successfully submitted */
  @Column({ type: "varchar", length: 100, nullable: true })
  hcmSubmissionId: string | null;

  /**
   * PENDING  = not yet submitted to HCM
   * SYNCED   = successfully submitted to HCM
   * FAILED   = submission failed; queued for retry
   */
  @Column({ type: "varchar", length: 20, default: "PENDING" })
  hcmSyncStatus: HcmSyncStatus;

  /** Last HCM submission error message for debugging */
  @Column({ type: "text", nullable: true })
  hcmSyncError: string | null;

  /** Number of HCM submission retry attempts */
  @Column({ type: "integer", default: 0 })
  hcmRetryCount: number;

  /**
   * Client-provided idempotency key. Duplicate requests with the same key
   * return the original request instead of creating a new one.
   */
  @Index({ unique: true, sparse: true })
  @Column({ type: "varchar", length: 100, nullable: true, unique: true })
  idempotencyKey: string | null;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;

  @BeforeInsert()
  generateId(): void {
    if (!this.id) {
      this.id = uuidv4();
    }
  }
}
