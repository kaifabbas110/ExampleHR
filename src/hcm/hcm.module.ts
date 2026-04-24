import { Module } from "@nestjs/common";
import { HttpModule } from "@nestjs/axios";
import { ConfigModule, ConfigService } from "@nestjs/config";
import { HcmIntegrationService } from "./hcm-integration.service";
import { HcmMockController } from "./hcm-mock.controller";
import { HcmMockService } from "./hcm-mock.service";

@Module({
  imports: [
    HttpModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        timeout: config.get<number>("hcm.timeoutMs", 5000),
        maxRedirects: 3,
      }),
    }),
  ],
  controllers: [HcmMockController],
  providers: [HcmIntegrationService, HcmMockService],
  exports: [HcmIntegrationService, HcmMockService],
})
export class HcmModule {}
