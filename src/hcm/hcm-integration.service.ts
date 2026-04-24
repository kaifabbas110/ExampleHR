import {
  Injectable,
  Logger,
  ServiceUnavailableException,
} from "@nestjs/common";
import { HttpService } from "@nestjs/axios";
import { ConfigService } from "@nestjs/config";
import { firstValueFrom, timeout } from "rxjs";
import {
  HcmBalanceResponse,
  HcmBatchSyncResponse,
  HcmSubmitLeaveDto,
  HcmSubmitLeaveResponse,
} from "./dto/hcm.dto";
import { withRetry, isRetryableHttpError } from "../common/utils/retry.util";

/**
 * HcmIntegrationService
 *
 * The sole integration point between ExampleHR and the external HCM system.
 * Encapsulates all HTTP communication, retry logic, error normalisation,
 * and provides a clean domain interface to the rest of the application.
 *
 * Key behaviours:
 *  1. Configurable exponential backoff retry (default 3 attempts)
 *  2. Per-request timeout (default 5s)
 *  3. Non-retryable 4xx errors fail immediately
 *  4. All HCM errors are wrapped in ServiceUnavailableException when
 *     the caller needs to surface the failure to the end user
 */
@Injectable()
export class HcmIntegrationService {
  private readonly logger = new Logger(HcmIntegrationService.name);
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly baseDelayMs: number;
  private readonly maxDelayMs: number;

  constructor(
    private readonly httpService: HttpService,
    private readonly config: ConfigService,
  ) {
    this.baseUrl = config.get<string>("hcm.baseUrl");
    this.apiKey = config.get<string>("hcm.apiKey");
    this.timeoutMs = config.get<number>("hcm.timeoutMs");
    this.maxRetries = config.get<number>("hcm.maxRetries");
    this.baseDelayMs = config.get<number>("hcm.retryBaseDelayMs");
    this.maxDelayMs = config.get<number>("hcm.retryMaxDelayMs");
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Public API
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Fetch the current leave balance for an employee from HCM.
   * Retries on 5xx / network errors with exponential backoff.
   *
   * @throws ServiceUnavailableException if all retries are exhausted.
   */
  async fetchBalance(hcmEmployeeId: string): Promise<HcmBalanceResponse> {
    this.logger.debug(
      `Fetching balance from HCM for employee ${hcmEmployeeId}`,
    );
    try {
      return await withRetry(
        () => this.get<HcmBalanceResponse>(`/balance/${hcmEmployeeId}`),
        {
          maxRetries: this.maxRetries,
          baseDelayMs: this.baseDelayMs,
          maxDelayMs: this.maxDelayMs,
          label: `HCM.fetchBalance(${hcmEmployeeId})`,
          retryIf: isRetryableHttpError,
        },
      );
    } catch (err) {
      this.logger.error(
        `HCM balance fetch failed for ${hcmEmployeeId}: ${(err as Error).message}`,
      );
      throw new ServiceUnavailableException(
        `HCM unavailable: cannot fetch balance for employee ${hcmEmployeeId}`,
      );
    }
  }

  /**
   * Submit an approved leave request to HCM.
   * This is called after the local approval transaction succeeds.
   * On failure, the caller stores hcmSyncStatus=FAILED for retry.
   *
   * @throws ServiceUnavailableException if all retries are exhausted.
   */
  async submitLeave(dto: HcmSubmitLeaveDto): Promise<HcmSubmitLeaveResponse> {
    this.logger.debug(
      `Submitting leave to HCM for employee ${dto.hcmEmployeeId}`,
    );
    try {
      return await withRetry(
        () => this.post<HcmSubmitLeaveResponse>("/leave/submit", dto),
        {
          maxRetries: this.maxRetries,
          baseDelayMs: this.baseDelayMs,
          maxDelayMs: this.maxDelayMs,
          label: `HCM.submitLeave(${dto.hcmEmployeeId})`,
          retryIf: isRetryableHttpError,
        },
      );
    } catch (err) {
      this.logger.error(
        `HCM leave submission failed for ${dto.hcmEmployeeId}: ${(err as Error).message}`,
      );
      throw new ServiceUnavailableException(
        `HCM unavailable: cannot submit leave for employee ${dto.hcmEmployeeId}`,
      );
    }
  }

  /**
   * Fetch all employee balances in a single batch call.
   * Used by the SyncService for periodic reconciliation.
   *
   * @throws ServiceUnavailableException if all retries are exhausted.
   */
  async fetchBatchSync(): Promise<HcmBatchSyncResponse> {
    this.logger.debug("Fetching batch balance sync from HCM");
    try {
      return await withRetry(
        () => this.get<HcmBatchSyncResponse>("/sync/batch"),
        {
          maxRetries: this.maxRetries,
          baseDelayMs: this.baseDelayMs,
          maxDelayMs: this.maxDelayMs,
          label: "HCM.fetchBatchSync",
          retryIf: isRetryableHttpError,
        },
      );
    } catch (err) {
      this.logger.error(`HCM batch sync failed: ${(err as Error).message}`);
      throw new ServiceUnavailableException(
        "HCM unavailable: batch sync failed",
      );
    }
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Private HTTP helpers
  // ─────────────────────────────────────────────────────────────────────────────

  private async get<T>(path: string): Promise<T> {
    const response = await firstValueFrom(
      this.httpService
        .get<T>(`${this.baseUrl}${path}`, {
          headers: this.defaultHeaders(),
        })
        .pipe(timeout(this.timeoutMs)),
    );
    return response.data;
  }

  private async post<T>(path: string, body: unknown): Promise<T> {
    const response = await firstValueFrom(
      this.httpService
        .post<T>(`${this.baseUrl}${path}`, body, {
          headers: this.defaultHeaders(),
        })
        .pipe(timeout(this.timeoutMs)),
    );
    return response.data;
  }

  private defaultHeaders(): Record<string, string> {
    return {
      "Content-Type": "application/json",
      "x-api-key": this.apiKey,
    };
  }
}
