import { exec } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const LOG_DIR = path.join(__dirname, '../log/logbin');
const SCRIPT = path.join(__dirname, '../src/RP/reverse_proxy.js');
const foreverCmd = 'forever';
const BASE_URL = 'http://localhost:4000';

const DEP_DIRS = [
  '../src/DNs',
  '../src/RP',
  '../src/serverdb',
  '../src/common/logger',
  '../test',
].map((p) => path.join(__dirname, p));


if (!fs.existsSync(LOG_DIR)) {
  fs.mkdirSync(LOG_DIR, { recursive: true });
}

function runForeverCommand(command, callback) {
  exec(
    `${foreverCmd} ${command} -a -l ${path.join(LOG_DIR, 'forever.log')} -o ${path.join(LOG_DIR, 'out.log')} -e ${path.join(LOG_DIR, 'err.log')} ${SCRIPT}`,
    (error, stdout, stderr) => {
      if (error) {
        console.error(`Error executing forever ${command}:`, error.message);
        callback(error);
        return;
      }
      callback(null, stdout.trim());
    }
  );
}

function start() {
  runForeverCommand('start', (err) => {
    if (!err) console.log('beedb started.');
  });
}

async function stop() {
  try {
    const res = await fetch(`${BASE_URL}/shutdown`, { method: 'POST' });
    const result = await res.text();
    console.log('Graceful shutdown response:', result);
  } catch (err) {
    console.error('Error sending shutdown POST:', err.message);
  }

  exec(`${foreverCmd} stop ${SCRIPT}`, (error) => {
    if (error) {
      console.error('Error stopping beedb:', error.message);
      return;
    }
    console.log('beedb stopped.');
  });
}

function restart() {
  stop();
  setTimeout(start, 1500);
}

async function status() {
  try {
    const res = await fetch(`${BASE_URL}/status`);
    const data = await res.text();
    console.log('Status:', data);
  } catch (err) {
    console.error('Failed to fetch status:', err.message);
  }
}

async function stats() {
  try {
    const res = await fetch(`${BASE_URL}/stats`);
    const data = await res.json();
    console.log('Stats:', data);
  } catch (err) {
    console.error('Failed to fetch stats:', err.message);
  }
}

function checkDeps() {
  console.log('Checking dependencies in modules...');
  DEP_DIRS.forEach((dir) => {
    const pkgPath = path.join(dir, 'package.json');
    const nodeModules = path.join(dir, 'node_modules');

    if (fs.existsSync(pkgPath)) {
      const hasModules = fs.existsSync(nodeModules) && fs.readdirSync(nodeModules).length > 0;

      if (!hasModules) {
        console.log(`Installing dependencies in ${dir}...`);
        exec('npm install', { cwd: dir }, (err, stdout, stderr) => {
          if (err) {
            console.error(`Failed to install in ${dir}:`, err.message);
          } else {
            console.log(`Installed dependencies in ${dir}`);
          }
        });
      } else {
        console.log(`Dependencies already installed in ${dir}`);
      }
    }
  });
}
function clean() {
  console.log('Cleaning project...');


  DEP_DIRS.forEach((dir) => {
    const nodeModulesPath = path.join(dir, 'node_modules');
    if (fs.existsSync(nodeModulesPath)) {
      fs.rmSync(nodeModulesPath, { recursive: true, force: true });
      console.log(`Deleted ${nodeModulesPath}`);
    }
  });


  const logPath = path.join(__dirname, '../log');
  if (fs.existsSync(logPath)) {
    fs.rmSync(logPath, { recursive: true, force: true });
    console.log(`Deleted ${logPath}`);
  }


  const dbDataPath = path.join(__dirname, '../DB-data');
  if (fs.existsSync(dbDataPath)) {
    fs.rmSync(dbDataPath, { recursive: true, force: true });
    console.log(`Deleted ${dbDataPath}`);
  }

  console.log('Cleanup complete.');
}


const cmd = process.argv[2];

if (!cmd) {
  console.error('Usage: node beeDB.js <start|stop|restart|status|stats|check-deps>');
  process.exit(1);
}

switch (cmd) {
  case 'start':
    start();
    break;
  case 'stop':
    stop();
    break;
  case 'restart':
    restart();
    break;
  case 'status':
    status();
    break;
  case 'stats':
    stats();
    break;
  case 'check-deps':
    checkDeps();
    break;
  case 'clean':
    clean();
    break;
  default:
    console.error(`Unknown command: ${cmd}`);
    process.exit(1);
}
