interface Env {
  DB: D1Database;
  APP_ORIGIN: string;
  ADMIN_ORIGIN: string;
  SESSION_TTL_DAYS: string;
  BOOTSTRAP_SECRET: string;
  PASSWORD_PEPPER: string;
  PASSWORD_RESET_SECRET?: string;
  RESEND_API_KEY?: string;
  SALES_EMAIL_FROM?: string;
  SALES_EMAIL_TO?: string;
}
