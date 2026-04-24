import {
  IsString,
  IsNotEmpty,
  IsOptional,
  IsIn,
  IsDateString,
  MaxLength,
  Validate,
  ValidatorConstraint,
  ValidatorConstraintInterface,
  ValidationArguments,
} from "class-validator";
import { LEAVE_TYPES } from "../../common/constants/leave-types.constant";

@ValidatorConstraint({ name: "EndDateAfterStartDate", async: false })
class EndDateAfterStartDate implements ValidatorConstraintInterface {
  validate(endDate: string, args: ValidationArguments): boolean {
    const obj = args.object as any;
    if (!obj.startDate || !endDate) return true; // let @IsDateString handle nulls
    return new Date(endDate) >= new Date(obj.startDate);
  }
  defaultMessage(): string {
    return "endDate must be on or after startDate";
  }
}

@ValidatorConstraint({ name: "FutureDateValidator", async: false })
class FutureDateValidator implements ValidatorConstraintInterface {
  validate(date: string): boolean {
    if (!date) return true;
    // Allow today or future dates
    const d = new Date(date);
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    return d >= today;
  }
  defaultMessage(): string {
    return "startDate must be today or a future date";
  }
}

export class CreateTimeOffRequestDto {
  @IsString()
  @IsNotEmpty()
  employeeId: string;

  @IsIn(LEAVE_TYPES, {
    message: `leaveType must be one of: ${LEAVE_TYPES.join(", ")}`,
  })
  leaveType: string;

  @IsDateString(
    {},
    { message: "startDate must be a valid ISO date (YYYY-MM-DD)" },
  )
  @Validate(FutureDateValidator)
  startDate: string;

  @IsDateString(
    {},
    { message: "endDate must be a valid ISO date (YYYY-MM-DD)" },
  )
  @Validate(EndDateAfterStartDate)
  endDate: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  reason?: string;

  /**
   * Optional client-generated idempotency key (UUID recommended).
   * If provided and a request with this key already exists, the existing
   * request is returned instead of creating a duplicate.
   */
  @IsOptional()
  @IsString()
  @MaxLength(100)
  idempotencyKey?: string;

  /**
   * Location context for this leave request.
   * Defaults to the employee's assigned locationId when omitted.
   */
  @IsOptional()
  @IsString()
  @MaxLength(50)
  locationId?: string;
}
