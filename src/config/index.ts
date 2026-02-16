import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().default(3000),
  HOST: z.string().default('0.0.0.0'),

  // Database
  DATABASE_URL: z.string(),

  // S3/Wasabi
  S3_ENDPOINT: z.string().url(),
  S3_REGION: z.string(),
  S3_BUCKET: z.string(),
  S3_ACCESS_KEY: z.string(),
  S3_SECRET_KEY: z.string(),
  S3_FORCE_PATH_STYLE: z.coerce.boolean().default(true),

  // Signed URL settings
  SIGNED_URL_TTL_SECONDS: z.coerce.number().default(120),

  // Edge Tunnel Authentication
  // Token that edge agents must provide to connect
  EDGE_TUNNEL_TOKEN: z.string().optional(),

  // Edge Tunnel Timeouts (milliseconds)
  EDGE_TUNNEL_HEALTH_TIMEOUT_MS: z.coerce.number().default(2000),
  EDGE_TUNNEL_TILE_TIMEOUT_MS: z.coerce.number().default(30000),

  // JWT Authentication
  JWT_SECRET: z.string().default('dev-jwt-secret-change-in-production'),
  JWT_EXPIRES_IN: z.string().default('7d'),

  // Google OAuth
  GOOGLE_CLIENT_ID: z.string().optional(),

  // UI-Bridge (Chrome Extension) Authentication
  UI_BRIDGE_API_KEY: z.string().optional(),

  // Magic Link JWT
  MAGIC_LINK_SECRET: z.string().optional(),
  MAGIC_LINK_TTL_SECONDS: z.coerce.number().default(300),

  // Thumb signing (HMAC) - defaults to MAGIC_LINK_SECRET at runtime
  THUMB_SIGN_SECRET: z.string().optional(),
  THUMB_SIGN_TTL_SECONDS: z.coerce.number().default(600),

  // Frontend URL for magic links
  FRONTEND_URL: z.string().default('http://localhost:3002'),

  // CORS allowed origins (comma-separated)
  ALLOWED_ORIGINS: z.string().optional(),
});

export type EnvConfig = z.infer<typeof envSchema>;

function loadConfig(): EnvConfig {
  const result = envSchema.safeParse(process.env);

  if (!result.success) {
    console.error('Invalid environment configuration:');
    console.error(result.error.format());
    process.exit(1);
  }

  return result.data;
}

export const config = loadConfig();

export default config;
