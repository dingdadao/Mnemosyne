#!/usr/bin/env node
/**
 * Mnemosyne CLI
 * 
 * Usage:
 *   mnemosyne start [--port 8790] [--host 0.0.0.0]
 *   mnemosyne token
 *   mnemosyne backup
 *   mnemosyne export [--output backup.json]
 *   mnemosyne stats
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(homedir(), '.mnemosyne');
const TOKEN_FILE = join(DATA_DIR, '.token');
const SERVER_SCRIPT = join(__dirname, '..', 'index.js');

const [,, cmd, ...args] = process.argv;

function getArg(name, defaultVal) {
  const idx = args.indexOf(`--${name}`);
  return idx !== -1 ? args[idx + 1] : defaultVal;
}

switch (cmd) {
  case 'start': {
    const port = getArg('port', process.env.MNEMOSYNE_PORT || '8790');
    const host = getArg('host', process.env.MNEMOSYNE_HOST || '0.0.0.0');
    
    console.log(`[mnemosyne] Starting server on ${host}:${port}...`);
    
    const child = spawn('node', [SERVER_SCRIPT, '--port', port, '--host', host], {
      stdio: 'inherit',
      env: { ...process.env }
    });
    
    child.on('error', (err) => {
      console.error('[mnemosyne] Failed to start:', err.message);
      process.exit(1);
    });
    
    break;
  }

  case 'token': {
    if (!existsSync(TOKEN_FILE)) {
      console.log('[mnemosyne] No token found. Start the server first to generate one.');
      process.exit(1);
    }
    const token = readFileSync(TOKEN_FILE, 'utf-8').trim();
    console.log(token);
    break;
  }

  case 'backup': {
    console.log('[mnemosyne] Backup: use HTTP API instead:');
    console.log(`  curl -X POST -H "Authorization: Bearer $(mnemosyne token)" http://localhost:8790/backup`);
    break;
  }

  case 'export': {
    const output = getArg('output', null);
    console.log('[mnemosyne] Export: use HTTP API instead:');
    console.log(`  curl -H "Authorization: Bearer $(mnemosyne token)" http://localhost:8790/export > ${output || 'backup.json'}`);
    break;
  }

  case 'help':
  case '--help':
  default:
    console.log(`
Mnemosyne — 中心化记忆服务器 CLI

Commands:
  start [--port N] [--host ADDR]   Start the server
  token                            Show the auth token
  backup                           Show backup command
  export [--output FILE]           Show export command
  help                             Show this help

Environment:
  MNEMOSYNE_PORT      Server port (default: 8790)
  MNEMOSYNE_HOST      Bind address (default: 0.0.0.0)
  MNEMOSYNE_TOKEN     Auth token (auto-generated if not set)
  MNEMOSYNE_DATA_DIR  Data directory (default: ~/.mnemosyne)
`);
    break;
}
