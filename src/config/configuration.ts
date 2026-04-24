export default () => ({
  port: parseInt(process.env.PORT ?? "3000", 10),
  nodeEnv: process.env.NODE_ENV ?? "development",
  appName: process.env.APP_NAME ?? "readyon-time-off-service",

  database: {
    path: process.env.DB_PATH ?? "./data/readyon.db",
  },

  hcm: {
    baseUrl: process.env.HCM_BASE_URL ?? "http://localhost:3000/mock-hcm",
    apiKey: process.env.HCM_API_KEY ?? "mock-hcm-api-key",
    timeoutMs: parseInt(process.env.HCM_TIMEOUT_MS ?? "5000", 10),
    maxRetries: parseInt(process.env.HCM_MAX_RETRIES ?? "3", 10),
    retryBaseDelayMs: parseInt(
      process.env.HCM_RETRY_BASE_DELAY_MS ?? "500",
      10,
    ),
    retryMaxDelayMs: parseInt(process.env.HCM_RETRY_MAX_DELAY_MS ?? "5000", 10),
  },

  sync: {
    cronSchedule: process.env.SYNC_CRON_SCHEDULE ?? "*/15 * * * *",
    enabled: process.env.SYNC_ENABLED !== "false",
  },

  balance: {
    staleThresholdMs: parseInt(
      process.env.BALANCE_STALE_THRESHOLD_MS ?? "900000",
      10,
    ),
    maxAcceptableStaleMs: parseInt(
      process.env.BALANCE_MAX_ACCEPTABLE_STALE_MS ?? "3600000",
      10,
    ),
  },

  mockHcm: {
    failureRate: parseFloat(process.env.MOCK_HCM_FAILURE_RATE ?? "0.2"),
    minDelayMs: parseInt(process.env.MOCK_HCM_MIN_DELAY_MS ?? "50", 10),
    maxDelayMs: parseInt(process.env.MOCK_HCM_MAX_DELAY_MS ?? "500", 10),
  },
});
