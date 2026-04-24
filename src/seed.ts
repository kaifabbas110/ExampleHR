import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module";
import { EmployeesService } from "./employees/employees.service";
import { HcmMockService } from "./hcm/hcm-mock.service";

/**
 * Seed script: creates the 5 employees that match the mock HCM seed data.
 * Run with: npm run seed
 */
async function seed() {
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ["log", "error"],
  });

  const employeesService = app.get(EmployeesService);
  const hcmMockService = app.get(HcmMockService);

  const employees = [
    {
      employeeCode: "EMP-001",
      name: "Alice Johnson",
      email: "alice.johnson@readyon.com",
      department: "Engineering",
      hcmEmployeeId: "HCM-EMP-001",
      locationId: "LOC-001",
    },
    {
      employeeCode: "EMP-002",
      name: "Bob Smith",
      email: "bob.smith@readyon.com",
      department: "Product",
      hcmEmployeeId: "HCM-EMP-002",
      locationId: "LOC-001",
    },
    {
      employeeCode: "EMP-003",
      name: "Carol White",
      email: "carol.white@readyon.com",
      department: "Design",
      hcmEmployeeId: "HCM-EMP-003",
      locationId: "LOC-002",
    },
    {
      employeeCode: "EMP-004",
      name: "David Lee",
      email: "david.lee@readyon.com",
      department: "Marketing",
      hcmEmployeeId: "HCM-EMP-004",
      locationId: "LOC-002",
    },
    {
      employeeCode: "EMP-005",
      name: "Eve Martinez",
      email: "eve.martinez@readyon.com",
      department: "HR",
      hcmEmployeeId: "HCM-EMP-005",
      locationId: "LOC-001",
    },
  ];

  console.log("\n=== ReadyOn Time-Off Service — Database Seeder ===\n");

  for (const emp of employees) {
    try {
      const created = await employeesService.create(emp);
      console.log(
        `✓ Created employee: ${created.employeeCode} — ${created.name} (ID: ${created.id})`,
      );
    } catch (err: any) {
      if (
        err?.message?.includes("UNIQUE constraint failed") ||
        err?.status === 409
      ) {
        console.log(`  Skipped (already exists): ${emp.employeeCode}`);
      } else {
        console.error(`✗ Failed to create ${emp.employeeCode}:`, err.message);
      }
    }
  }

  console.log("\nSeeding complete.");
  console.log("\nMock HCM seed data (HCM balances for these employees):");
  const batchData = await hcmMockService.getBatchSync();
  for (const record of batchData.records) {
    console.log(`\n  ${record.hcmEmployeeId}:`);
    for (const b of record.balances) {
      console.log(
        `    ${b.leaveType.padEnd(12)} total=${b.totalDays} used=${b.usedDays} available=${b.availableDays}`,
      );
    }
  }

  await app.close();
}

seed().catch((err) => {
  console.error("Seed failed:", err);
  process.exit(1);
});
