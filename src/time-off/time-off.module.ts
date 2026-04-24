import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import { Employee } from "../entities/employee.entity";
import { LeaveBalance } from "../entities/leave-balance.entity";
import { LeaveRequest } from "../entities/leave-request.entity";
import { TimeOffService } from "./time-off.service";
import { TimeOffController } from "./time-off.controller";
import { HcmModule } from "../hcm/hcm.module";

@Module({
  imports: [
    TypeOrmModule.forFeature([Employee, LeaveBalance, LeaveRequest]),
    HcmModule,
  ],
  providers: [TimeOffService],
  controllers: [TimeOffController],
  exports: [TimeOffService],
})
export class TimeOffModule {}
