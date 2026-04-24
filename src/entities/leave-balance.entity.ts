import {
  Entity,
  PrimaryColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  ManyToOne,
  JoinColumn,
  BeforeInsert,
  VersionColumn,
  Unique,
} from "typeorm";
import { v4 as uuidv4 } from "uuid";
import { Employee } from "./employee.entity";
import {
  LeaveType,
  LEAVE_TYPES,
} from "../common/constants/leave-types.constant";

@Entity("leave_balances")
@Unique(["employeeId", "locationId", "leaveType"])
export class LeaveBalance {
  @PrimaryColumn("varchar", { length: 36 })
  id: string;

  @Column()
  employeeId: string;

  /** Location this balance applies to (e.g. "LOC-001") */
  @Column({ type: "varchar", length: 50 })
  locationId: string;

  @ManyToOne(() => Employee, (employee) => employee.leaveBalances, {
    onDelete: "CASCADE",
  })
  @JoinColumn({ name: "employeeId" })
  employee: Employee;

  /** Leave type: ANNUAL | SICK | EMERGENCY | MATERNITY | PATERNITY | UNPAID */
  @Column({ type: "varchar", length: 20 })
  leaveType: LeaveType;

  /** Total days allocated by HCM for this period */
  @Column({ type: "real", default: 0 })
  totalDays: number;

  /** Days already consumed (approved and submitted to HCM) */
  @Column({ type: "real", default: 0 })
  usedDays: number;

  /**
   * Days reserved by PENDING requests (not yet approved).
   * This is a local-only counter; HCM is unaware of these.
   */
  @Column({ type: "real", default: 0 })
  pendingDays: number;

  /** When did we last successfully fetch this balance from HCM? */
  @Column({ type: "datetime", nullable: true })
  hcmLastSyncedAt: Date | null;

  /**
   * Optimistic lock version. TypeORM auto-increments this on every save.
   * Used to detect concurrent updates and avoid double-deduction.
   */
  @VersionColumn()
  version: number;

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

  /** Computed: days available for new requests */
  get availableDays(): number {
    return Math.max(0, this.totalDays - this.usedDays - this.pendingDays);
  }

  /** Returns true if the cached balance is older than the given threshold */
  isStale(thresholdMs: number): boolean {
    if (!this.hcmLastSyncedAt) return true;
    return Date.now() - new Date(this.hcmLastSyncedAt).getTime() > thresholdMs;
  }
}
