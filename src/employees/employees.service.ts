import {
  Injectable,
  NotFoundException,
  ConflictException,
  Logger,
} from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import { Employee } from "../entities/employee.entity";
import { LeaveBalance } from "../entities/leave-balance.entity";
import { CreateEmployeeDto } from "./dto/create-employee.dto";
import {
  LEAVE_TYPES,
  LeaveType,
} from "../common/constants/leave-types.constant";

@Injectable()
export class EmployeesService {
  private readonly logger = new Logger(EmployeesService.name);

  constructor(
    @InjectRepository(Employee)
    private readonly employeeRepo: Repository<Employee>,
    @InjectRepository(LeaveBalance)
    private readonly balanceRepo: Repository<LeaveBalance>,
  ) {}

  /**
   * Create a new employee and seed their leave balance records (all set to 0;
   * balances will be populated on first HCM sync).
   */
  async create(dto: CreateEmployeeDto): Promise<Employee> {
    const existing = await this.employeeRepo.findOne({
      where: [{ employeeCode: dto.employeeCode }, { email: dto.email }],
    });

    if (existing) {
      throw new ConflictException(
        `Employee with code '${dto.employeeCode}' or email '${dto.email}' already exists`,
      );
    }

    const employee = this.employeeRepo.create(dto);
    const savedEmployee = await this.employeeRepo.save(employee);

    // Seed zero-balance records for all leave types
    const balanceRecords = (LEAVE_TYPES as readonly LeaveType[]).map(
      (leaveType) => {
        const b = this.balanceRepo.create({
          employeeId: savedEmployee.id,
          locationId: savedEmployee.locationId,
          leaveType,
          totalDays: 0,
          usedDays: 0,
          pendingDays: 0,
          hcmLastSyncedAt: null,
        });
        return b;
      },
    );
    await this.balanceRepo.save(balanceRecords);

    this.logger.log(
      `Created employee ${savedEmployee.id} (${savedEmployee.employeeCode})`,
    );
    return savedEmployee;
  }

  async findAll(): Promise<Employee[]> {
    return this.employeeRepo.find({
      where: { isActive: true },
      order: { createdAt: "ASC" },
    });
  }

  async findOne(id: string): Promise<Employee> {
    const employee = await this.employeeRepo.findOne({
      where: { id },
      relations: ["leaveBalances"],
    });
    if (!employee) {
      throw new NotFoundException(`Employee ${id} not found`);
    }
    return employee;
  }

  async findByEmployeeCode(employeeCode: string): Promise<Employee> {
    const employee = await this.employeeRepo.findOne({
      where: { employeeCode },
    });
    if (!employee) {
      throw new NotFoundException(
        `Employee with code ${employeeCode} not found`,
      );
    }
    return employee;
  }

  async findByHcmId(hcmEmployeeId: string): Promise<Employee | null> {
    return this.employeeRepo.findOne({ where: { hcmEmployeeId } });
  }

  async deactivate(id: string): Promise<Employee> {
    const employee = await this.findOne(id);
    employee.isActive = false;
    return this.employeeRepo.save(employee);
  }
}
