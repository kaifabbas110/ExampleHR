import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Put,
  Query,
  HttpCode,
  HttpStatus,
} from "@nestjs/common";
import { TimeOffService } from "./time-off.service";
import { CreateTimeOffRequestDto } from "./dto/create-time-off-request.dto";
import { ApproveTimeOffDto } from "./dto/approve-time-off.dto";

@Controller("time-off")
export class TimeOffController {
  constructor(private readonly timeOffService: TimeOffService) {}

  /**
   * POST /time-off/request
   * Submit a leave request. Returns 201 on creation; 200 if idempotency key matches an existing request.
   */
  @Post("request")
  @HttpCode(HttpStatus.CREATED)
  createRequest(@Body() dto: CreateTimeOffRequestDto) {
    return this.timeOffService.createRequest(dto);
  }

  /**
   * GET /time-off/balance?employeeId=:id
   * Returns leave balances. Attempts live HCM fetch; degrades to cache.
   */
  @Get("balance")
  getBalance(@Query("employeeId") employeeId: string) {
    if (!employeeId) {
      return { error: "employeeId query parameter is required" };
    }
    return this.timeOffService.getBalance(employeeId);
  }

  /**
   * GET /time-off/history?employeeId=:id&status=&leaveType=&year=&page=&limit=
   * Paginated leave request history.
   */
  @Get("history")
  getHistory(
    @Query("employeeId") employeeId: string,
    @Query("status") status?: string,
    @Query("leaveType") leaveType?: string,
    @Query("year") year?: string,
    @Query("page") page?: string,
    @Query("limit") limit?: string,
  ) {
    return this.timeOffService.getHistory(employeeId, {
      status,
      leaveType,
      year: year ? parseInt(year, 10) : undefined,
      page: page ? parseInt(page, 10) : 1,
      limit: limit ? Math.min(parseInt(limit, 10), 100) : 20,
    });
  }

  /**
   * PUT /time-off/approve/:id
   * Approve or reject a pending leave request.
   */
  @Put("approve/:id")
  processApproval(@Param("id") id: string, @Body() dto: ApproveTimeOffDto) {
    return this.timeOffService.processApproval(id, dto);
  }
}
