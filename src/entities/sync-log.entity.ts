import {
  Entity,
  PrimaryColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  BeforeInsert,
  Index,
} from "typeorm";
import { v4 as uuidv4 } from "uuid";
import { SyncType, SyncStatus } from "../common/constants/leave-types.constant";

@Entity("sync_logs")
@Index(["status"])
export class SyncLog {
  @PrimaryColumn("varchar", { length: 36 })
  id: string;

  @Column({ type: "varchar", length: 20 })
  syncType: SyncType;

  @Column({ type: "varchar", length: 20, default: "RUNNING" })
  status: SyncStatus;

  @Column({ type: "integer", default: 0 })
  recordsProcessed: number;

  @Column({ type: "integer", default: 0 })
  recordsFailed: number;

  /** Stores JSON summary of per-employee failures */
  @Column({ type: "text", nullable: true })
  errorMessage: string | null;

  /** "SCHEDULER" | "MANUAL" | employee ID for targeted sync */
  @Column({ type: "varchar", length: 100, nullable: true })
  triggeredBy: string | null;

  @CreateDateColumn()
  startedAt: Date;

  @Column({ type: "datetime", nullable: true })
  completedAt: Date | null;

  @UpdateDateColumn()
  updatedAt: Date;

  @BeforeInsert()
  generateId(): void {
    if (!this.id) {
      this.id = uuidv4();
    }
  }
}
