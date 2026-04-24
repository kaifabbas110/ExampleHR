import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import { Employee } from "../entities/employee.entity";
import { LeaveBalance } from "../entities/leave-balance.entity";
import { LeaveRequest } from "../entities/leave-request.entity";
import { SyncLog } from "../entities/sync-log.entity";
import { SyncService } from "./sync.service";
import { SyncController } from "./sync.controller";
import { SyncScheduler } from "./sync.scheduler";
import { HcmModule } from "../hcm/hcm.module";
import { TimeOffModule } from "../time-off/time-off.module";

@Module({
  imports: [
    TypeOrmModule.forFeature([Employee, LeaveBalance, LeaveRequest, SyncLog]),
    HcmModule,
    TimeOffModule,
  ],
  providers: [SyncService, SyncScheduler],
  controllers: [SyncController],
  exports: [SyncService],
})
export class SyncModule {}
