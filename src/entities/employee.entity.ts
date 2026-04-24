import {
  Entity,
  PrimaryColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  OneToMany,
  BeforeInsert,
} from "typeorm";
import { v4 as uuidv4 } from "uuid";
import { LeaveBalance } from "./leave-balance.entity";
import { LeaveRequest } from "./leave-request.entity";

@Entity("employees")
export class Employee {
  @PrimaryColumn("varchar", { length: 36 })
  id: string;

  /** Internal HR employee identifier (e.g. "EMP-001") */
  @Column({ unique: true })
  employeeCode: string;

  @Column()
  name: string;

  @Column({ unique: true })
  email: string;

  @Column({ nullable: true })
  department: string;

  /** Location this employee is assigned to (e.g. "LOC-001") */
  @Column({ type: "varchar", length: 50 })
  locationId: string;

  /** The ID used to look up this employee in HCM */
  @Column({ unique: true })
  hcmEmployeeId: string;

  @Column({ default: true })
  isActive: boolean;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;

  @OneToMany(() => LeaveBalance, (balance) => balance.employee, {
    cascade: true,
  })
  leaveBalances: LeaveBalance[];

  @OneToMany(() => LeaveRequest, (request) => request.employee, {
    cascade: false,
  })
  leaveRequests: LeaveRequest[];

  @BeforeInsert()
  generateId(): void {
    if (!this.id) {
      this.id = uuidv4();
    }
  }
}
