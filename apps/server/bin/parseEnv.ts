import { z, ZodError, ZodIntersection, ZodTypeAny } from "zod";

const commonSchema = z.object({
  NODE_ENV: z.enum(["local", "dev", "test", "production"]).default("local"),
  SERVER_HOST: z.string().default("0.0.0.0"),
  SERVER_PORT: z.coerce.number().positive().default(8888),
  QUICKNODE_MAINNET_URL: z.string().default("https://mainnet.helius-rpc.com"),
  JUPITER_URL: z.string(),
  HASURA_ADMIN_SECRET: z.string().default("password"),
  GRAPHQL_URL: z.string().default("http://localhost:8080/v1/graphql"),
  FEE_PAYER_PRIVATE_KEY: z.string(),
  JWT_SECRET: z.string().default("secret"),
  COINBASE_CDP_API_KEY_NAME: z.string().default(""),
  COINBASE_CDP_API_KEY_PRIVATE_KEY: z.string().default(""),
  PRIVY_APP_ID: z.string(),
  PRIVY_APP_SECRET: z.string(),
  CODEX_API_KEY: z.string(),
  OCTANE_TRADE_FEE_RECIPIENT: z.string(),
  OCTANE_BUY_FEE: z.coerce.number().default(100),
  OCTANE_SELL_FEE: z.coerce.number().default(0),
  OCTANE_MIN_TRADE_SIZE: z.coerce.number().default(15),
});

export function parseEnv<TSchema extends ZodTypeAny | undefined = undefined>(
  schema?: TSchema,
): z.infer<TSchema extends ZodTypeAny ? ZodIntersection<typeof commonSchema, TSchema> : typeof commonSchema> {
  const envSchema = schema !== undefined ? z.intersection(commonSchema, schema) : commonSchema;
  try {
    return envSchema.parse(process.env);
  } catch (error) {
    if (error instanceof ZodError) {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { _errors, ...invalidEnvVars } = error.format();
      console.error(`\nMissing or invalid environment variables:\n\n  ${Object.keys(invalidEnvVars).join("\n  ")}\n`);
      process.exit(1);
    }
    throw error;
  }
}
