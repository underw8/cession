// Secrets and .dev.vars entries wrangler types can't see.
interface Env {
  SETUP_CODE?: string;
  DEV_SKIP_AUTH?: string;
}
