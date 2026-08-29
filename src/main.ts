import { startServer } from './server.ts';

const configPath = process.argv[2];
await startServer(configPath);
