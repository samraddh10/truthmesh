import { loadDotEnvFile } from '@superjoin/config';

import { buildServer } from './server.ts';

loadDotEnvFile();

const server = await buildServer();

async function shutdown(signal: string): Promise<void> {
  server.app.log.info({ signal }, 'shutting down');
  try {
    await server.close();
    process.exit(0);
  } catch (error) {
    server.app.log.error({ err: error }, 'shutdown failed');
    process.exit(1);
  }
}

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => void shutdown(signal));
}

try {
  await server.app.listen({ host: '0.0.0.0', port: server.config.port });
} catch (error) {
  server.app.log.error({ err: error }, 'failed to start');
  await server.close();
  process.exit(1);
}
