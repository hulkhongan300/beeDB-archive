const express = require('express');
const { fork } = require('child_process');
const path = require('path');
const axios = require('axios');
const logger = require('../common/logger/logger'); 
const NODE_ID = process.argv[2] || 0;
const CONFIG = require('../../etc/config.json');
const DEFAULT_PORT = 5000 + parseInt(NODE_ID);
let CURRENT_PORT = DEFAULT_PORT;

const app = express();
let server = null;
const serverProcesses = [];
let isShuttingDown = false;

async function startServer(port) {
  CURRENT_PORT = port;

  server = app.listen(port, () => {
    logger.info(`Data Node ${NODE_ID} running on port ${port}`, { nodeId: NODE_ID, port });
  });
}

// Start ServerDB
function launchServerDBs() {
  CONFIG.nodes[NODE_ID].servers.forEach(server => {
    const child = fork(path.join(__dirname, '../serverdb/serverdb.js'), [], {
      env: {
        PORT: server.port,
        NODE_ID: NODE_ID,
        SERVER_ID: server.id,
        DATA_DIR: CONFIG.db_data_directory
      },
      stdio: 'inherit'
    });

    serverProcesses.push(child);

    child.on('exit', (code) => {
      logger.error(`ServerDB ${server.port} exited with code ${code}`, { serverPort: server.port, exitCode: code });
      process.exit(1);
    });
  });
}

async function findLeaderPort(servers, retries = 5, delay = 1000) {
  for (let attempt = 0; attempt < retries; attempt++) {
    for (const server of servers) {
      try {
        const response = await axios.get(`http://localhost:${server.port}/status`, { timeout: 500 });
        const status = response.data;
        if (status.raft && status.raft.state === 'leader') {
          logger.info('Leader found', { nodeId: NODE_ID, leaderPort: server.port });
          return server.port;
        }
      } catch (err) {
        logger.debug('Leader check failed', { serverPort: server.port, error: err.message });
      }
    }
    await new Promise(resolve => setTimeout(resolve, delay));
  }
  logger.warn('No leader found after retries', { nodeId: NODE_ID, retries });
  return null;
}

// API routes
app.get('/data/:key', async (req, res) => {
  try {
    const servers = CONFIG.nodes[NODE_ID].servers;
    const leaderPort = await findLeaderPort(servers);
    if (!leaderPort) {
      logger.warn('GET data failed: no leader found');
      return res.status(503).json({ error: 'No leader found, try again later' });
    }
    const response = await axios.get(`http://localhost:${leaderPort}/data/${req.params.key}`);
    res.json(response.data);
  } catch (err) {
    logger.error('GET data failed', { error: err.message, key: req.params.key });
    res.status(500).json({ error: err.message });
  }
});

app.post('/data/:key', express.json(), async (req, res) => {
  try {
    const servers = CONFIG.nodes[NODE_ID].servers;
    const leaderPort = await findLeaderPort(servers);
    if (!leaderPort) {
      logger.warn('POST data failed: no leader found');
      return res.status(503).json({ error: 'No leader found, try again later' });
    }
    const response = await axios.post(`http://localhost:${leaderPort}/data/${req.params.key}`, req.body);
    res.json(response.data);
  } catch (err) {
    logger.error('POST data failed', { error: err.message, key: req.params.key });
    res.status(500).json({ error: err.message });
  }
});

app.post('/db/c', express.json(), async (req, res) => {
  const { key, value } = req.body;
  if (!key || value === undefined) {
    logger.warn('POST /db/c failed: Missing key or value', { body: req.body });
    return res.status(400).json({ error: 'Missing key or value' });
  }
  const leaderPort = await findLeaderPort(CONFIG.nodes[NODE_ID].servers);
  if (!leaderPort) {
    logger.warn('POST /db/c failed: no leader found');
    return res.status(503).json({ error: 'No leader found, try again later' });
  }

  try {
    const response = await axios.post(`http://localhost:${leaderPort}/db/c`, { key, value });
    logger.info('Forwarded create request to leader', { key, value, leaderPort });
    res.json(response.data);
  } catch (err) {
    logger.error('Forwarding create to leader failed', { error: err.message, key });
    res.status(500).json({ error: 'Leader write failed', details: err.message });
  }
});

app.delete('/db/d', async (req, res) => {
  const key = req.query.key;
  if (!key) {
    logger.warn('DELETE /db/d failed: Missing key');
    return res.status(400).json({ error: 'Missing key' });
  }

  try {
    const leaderPort = await findLeaderPort(CONFIG.nodes[NODE_ID].servers);
    if (!leaderPort) {
      logger.warn('DELETE /db/d failed: no leader found');
      return res.status(503).json({ error: 'No leader found, try again later' });
    }

    const response = await axios.delete(`http://localhost:${leaderPort}/db/d`, { params: { key } });
    logger.info('Forwarded delete request to leader', { key, leaderPort });
    res.json(response.data);

  } catch (err) {
    logger.error('Delete request failed', { error: err.message, key });
    res.status(500).json({ error: 'Delete failed: ' + err.message });
  }
});


app.get('/status', async (req, res) => {
  const nodeStatus = {
    status: 'healthy',
    servers: {}
  };

  for (const server of CONFIG.nodes[NODE_ID].servers) {
    try {
      const response = await axios.get(`http://localhost:${server.port}/status`, { timeout: 1000 });
      nodeStatus.servers[`server_${server.port}`] = response.data;
      if (response.data.status !== 'healthy') {
        nodeStatus.status = 'degraded';
      }
    } catch (err) {
      nodeStatus.servers[`server_${server.port}`] = { status: 'unhealthy', error: err.message };
      nodeStatus.status = 'degraded';
      logger.warn('Server status check failed', { serverPort: server.port, error: err.message });
    }
  }

  const leaderPort = await findLeaderPort(CONFIG.nodes[NODE_ID].servers);

  res.json({
    nodeId: NODE_ID,
    port: leaderPort || null,
    ...nodeStatus
  });
});


axios.post(`http://localhost:${CONFIG.server.port}/register`, {
  nodeId: parseInt(NODE_ID),
  port: CURRENT_PORT
}).then(() => {
  logger.info(`Data Node ${NODE_ID} registered with reverse proxy`, { nodeId: NODE_ID, port: CURRENT_PORT });
}).catch(err => {
  logger.error(`Failed to register Data Node ${NODE_ID} with reverse proxy`, { error: err.message });
});

app.post('/stop', async (req, res) => {
  if (isShuttingDown) {
    logger.warn('Stop request rejected: Already shutting down');
    return res.status(400).send('Already shutting down');
  }
  
  isShuttingDown = true;
  logger.info(`Stopping Data Node ${NODE_ID}...`);

  // Stop all server
  serverProcesses.forEach(proc => {
    try {
      proc.kill();
      logger.info(`Killed child server process with PID ${proc.pid}`);
    } catch (e) {
      logger.warn(`Failed to kill server process`, { error: e.message });
    }
  });

  // Close HTTP server
  if (server) {
    server.close(() => {
      logger.info(`Data Node ${NODE_ID} stopped`);
      res.send(`Data Node ${NODE_ID} stopped`);
      process.exit(0);
    });


    setTimeout(() => {
      logger.warn(`Force exiting Data Node ${NODE_ID}`);
      process.exit(1);
    }, 3000);
  } else {
    res.send(`Data Node ${NODE_ID} stopped`);
    process.exit(0);
  }
});


function shutdown() {
  if (isShuttingDown) return;
  isShuttingDown = true;
  
  logger.info(`Data Node ${NODE_ID}: Shutting down...`);
  serverProcesses.forEach(child => child.kill());
  
  if (server) {
    server.close(() => {
      logger.info(`Data Node ${NODE_ID}: Clean shutdown`);
      process.exit(0);
    });
  }

  setTimeout(() => {
    logger.warn(`Data Node ${NODE_ID}: Force exit`);
    process.exit(1);
  }, 5000);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

function hash(str) {
  return str.split('').reduce((a, b) => (((a << 5) - a) + b.charCodeAt(0)) | 0, 0);
}


(async function main() {
  launchServerDBs();
  await startServer(DEFAULT_PORT);
  const leaderPort = await findLeaderPort(CONFIG.nodes[NODE_ID].servers);
  if (leaderPort && leaderPort !== DEFAULT_PORT) {
    logger.info(`Leader ServerDB found on port ${leaderPort}, switching data node...`);
    server.close(async () => {
      await startServer(leaderPort);
    });
  }
})();
