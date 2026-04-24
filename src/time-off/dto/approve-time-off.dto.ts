import {
  IsString,
  IsNotEmpty,
  IsIn,
  IsOptional,
  MaxLength,
} from "class-validator";

export class ApproveTimeOffDto {
  /** 'APPROVE' or 'REJECT' */
  @IsIn(["APPROVE", "REJECT"], {
    message: "action must be 'APPROVE' or 'REJECT'",
  })
  action: "APPROVE" | "REJECT";

  /** UUID of the manager performing the action */
  @IsString()
  @IsNotEmpty()
  approverId: string;

  /** Required when action = 'REJECT' */
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  rejectedReason?: string;
}
