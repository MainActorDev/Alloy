#!/usr/bin/env node
import { startServer } from '../dist/index.js';

const configPath = process.argv[2];
await startServer(configPath);
