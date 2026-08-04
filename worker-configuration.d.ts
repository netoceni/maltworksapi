interface Env {
  DB: D1Database;
  APP_ORIGIN: string;
  SESSION_TTL_DAYS: string;
  BOOTSTRAP_SECRET: string;
  PASSWORD_PEPPER: string;
  PASSWORD_RESET_SECRET?: string;
}
