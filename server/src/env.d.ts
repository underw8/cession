// Secrets and .dev.vars entries wrangler types can't see.
interface Env {
  INGEST_TOKEN?: string;
  SETUP_CODE?: string;
  DEV_SKIP_AUTH?: string;
}
