import { Body, Controller, Delete, Get, Param, Post } from "@nestjs/common";
import { EmployeesService } from "./employees.service";
import { CreateEmployeeDto } from "./dto/create-employee.dto";

@Controller("employees")
export class EmployeesController {
  constructor(private readonly employeesService: EmployeesService) {}

  @Post()
  create(@Body() dto: CreateEmployeeDto) {
    return this.employeesService.create(dto);
  }

  @Get()
  findAll() {
    return this.employeesService.findAll();
  }

  @Get(":id")
  findOne(@Param("id") id: string) {
    return this.employeesService.findOne(id);
  }

  @Delete(":id")
  deactivate(@Param("id") id: string) {
    return this.employeesService.deactivate(id);
  }
}
