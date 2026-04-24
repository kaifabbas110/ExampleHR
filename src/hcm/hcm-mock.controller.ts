import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
} from "@nestjs/common";
import { HcmMockService } from "./hcm-mock.service";
import { HcmSubmitLeaveDto } from "./dto/hcm.dto";

/**
 * MockHcmController
 *
 * Exposes a simulated HCM REST API at /mock-hcm/*.
 * This controller exists only for development and testing purposes.
 * In production, the HCM base URL would point to the real external HCM system.
 *
 * Endpoints mirror what a real HCM would expose:
 *  GET  /mock-hcm/balance/:hcmEmployeeId  — fetch employee leave balance
 *  POST /mock-hcm/leave/submit            — submit approved leave
 *  GET  /mock-hcm/sync/batch              — batch export all balances
 *  POST /mock-hcm/admin/reset             — reset to seed data (tests only)
 */
@Controller("mock-hcm")
export class HcmMockController {
  constructor(private readonly mockService: HcmMockService) {}

  @Get("balance/:hcmEmployeeId")
  async getBalance(@Param("hcmEmployeeId") hcmEmployeeId: string) {
    return this.mockService.getBalance(hcmEmployeeId);
  }

  @Post("leave/submit")
  async submitLeave(@Body() dto: HcmSubmitLeaveDto) {
    return this.mockService.submitLeave(dto);
  }

  @Get("sync/batch")
  async getBatchSync() {
    return this.mockService.getBatchSync();
  }

  /** Reset all mock data to seed values — useful for test isolation */
  @Post("admin/reset")
  @HttpCode(HttpStatus.OK)
  reset() {
    this.mockService.reset();
    return { message: "Mock HCM data reset to seed values" };
  }
}
