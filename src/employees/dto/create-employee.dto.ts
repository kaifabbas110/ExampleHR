import {
  IsString,
  IsEmail,
  IsNotEmpty,
  IsOptional,
  MaxLength,
  Matches,
} from "class-validator";

export class CreateEmployeeDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(50)
  @Matches(/^[A-Z0-9-]+$/, {
    message: "employeeCode must be uppercase alphanumeric with dashes",
  })
  employeeCode: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  name: string;

  @IsEmail()
  email: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  department?: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  hcmEmployeeId: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(50)
  locationId: string;
}
