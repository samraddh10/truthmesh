import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/schema/index.ts',
  out: './migrations',
  dbCredentials: {
    url: process.env['DATABASE_URL'] ?? 'postgres://superjoin:superjoin@localhost:55432/superjoin',
  },
  verbose: true,
  strict: true,
});
