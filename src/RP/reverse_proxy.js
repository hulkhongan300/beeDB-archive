const express = require('express');
const { fork } = require('child_process');
const path = require('path');
const fs = require('fs');
const md5 = require('md5');
const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));
const logger = require('../common/logger/logger');

const app = express();
const CONFIG = JSON.parse(fs.readFileSync(path.join(__dirname, '../../etc/config.json'), 'utf-8'));


const childProcesses = [];

const STATUS_CHECK_INTERVAL = 5000; // 5 seconds

// Health status storage
const healthStatus = {
  reverseProxy: 'healthy',
  dataNodes: {},
  serverDBs: {}
};
const NODE_NAME_TO_ID = {};

// Start Data Nodes
CONFIG.nodes.forEach((node, idx) => {
  const dn = fork(path.join(__dirname, '../DNs/data_node.js'), [idx.toString()], {
    stdio: 'inherit'
  });
  dn.nodeId = idx;
  childProcesses.push(dn);
  dn.on('exit', (code) => {
    logger.error(`Data Node ${idx} exited with code ${code}`);
    const index = childProcesses.indexOf(dn);
    if (index !== -1) childProcesses.splice(index, 1);
  });
  NODE_NAME_TO_ID[node.name] = idx;
});

function successResponse(data) {
  return {
    error: 0,
    data: data || 0
  };
}

function errorResponse(code, errno, message) {
  return {
    error: {
      code,
      errno,
      message
    },
    data: 0
  };
}

function getKeyHash(key) {
  return md5(String(key));
}

function nodeIndexForKey(key) {
  const hashHex = md5(String(key));
  const last8 = hashHex.slice(-16);
  const hashNum = BigInt('0x' + last8);
  return Number(hashNum % BigInt(CONFIG.nodes.length));
}

async function locateLeaderForKey(key) {
  const nodeIndex = nodeIndexForKey(key);
  const leaderPort = await getLeaderPort(nodeIndex);
  return { nodeIndex, leaderPort };
}

async function getLeaderPort(nodeIndex) {
  const node = CONFIG.nodes[nodeIndex];

  for (const server of node.servers) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 1000);

      const response = await fetch(`http://localhost:${server.port}/status`, { signal: controller.signal });
      clearTimeout(timeout);

      if (!response.ok) {
        continue; 
      }

      const data = await response.json();

      if (data.raft?.state === 'leader') {
        return server.port;
      }
    } catch (e) {
    }
  }
  throw new Error(`No leader found for node ${nodeIndex}`);
}

async function postJson(url, body) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  const data = await response.json();
  if (!response.ok) {
    const error = new Error(`HTTP error! status: ${response.status}`);
    error.status = response.status;
    error.data = data;
    throw error;
  }
  return data;
}

async function getJson(url) {
  const response = await fetch(url);
  const data = await response.json();
  if (!response.ok) {
    const error = new Error(`HTTP error! status: ${response.status}`);
    error.status = response.status;
    error.data = data;
    throw error;
  }
  return data;
}

async function deleteJson(url) {
  const response = await fetch(url, { method: 'DELETE' });
  const data = await response.json();
  if (!response.ok) {
    const error = new Error(`HTTP error! status: ${response.status}`);
    error.status = response.status;
    error.data = data;
    throw error;
  }
  return data;
}

function hash(str) {
  return str.split('').reduce((a, b) => (((a << 5) - a) + b.charCodeAt(0)) | 0, 0);
}

app.get('/data/:key', async (req, res) => {
  try {
    const nodeId = Math.abs(hash(req.params.key)) % CONFIG.nodes.length;
    const data = await getJson(`http://localhost:${5000 + nodeId}/data/${req.params.key}`);
    res.json(data);
  } catch (err) {
    logger.error(`GET /data/${req.params.key} error: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

const dataNodeRegistry = {};

app.post('/register', express.json(), (req, res) => {
  const { nodeId, port } = req.body;

  if (typeof nodeId !== 'number' || typeof port !== 'number') {
    logger.warn(`Invalid registration attempt: nodeId=${nodeId}, port=${port}`);
    return res.status(400).json({ error: 'Invalid registration' });
  }

  dataNodeRegistry[nodeId] = port;
  logger.info(`Registered Data Node ${nodeId} on port ${port}`);
  res.json({ status: 'ok' });
});

app.get('/status', async (req, res) => {
  let lines = [];

  try {
    const reverseProxyPort = CONFIG.server.port;
    lines.push(`reverse proxy (port ${reverseProxyPort}): ok`);

    for (const [nodeIndex, node] of CONFIG.nodes.entries()) {
      const nodeLines = [`${node.name} {`];

      for (const server of node.servers) {
        const port = server.port;

        try {
          const controller = new AbortController();
          const timeout = setTimeout(() => controller.abort(), 1000);

          const response = await fetch(`http://localhost:${port}/status`, { signal: controller.signal });
          clearTimeout(timeout);

          if (!response.ok) {
            nodeLines.push(`  serverdb (port ${port}): error | unknown`);
            continue;
          }

          const data = await response.json();
          const uptime = data.uptime !== undefined ? `${data.uptime}s` : 'unknown';
          const status = data.status === 'healthy' ? 'ok' : 'error';
          const role = data.raft?.state || 'unknown';

          nodeLines.push(`  serverdb (port ${port}): ${status} | ${role} | uptime: ${uptime}`);
        } catch (err) {
          nodeLines.push(`  serverdb (port ${port}): error | unknown`);
          logger.warn(`Status check failed for serverdb port ${port}: ${err.message}`);
        }
      }

      nodeLines.push('}');
      lines.push(nodeLines.join('\n'));
    }

    res.type('text/plain').send(lines.join('\n'));
  } catch (err) {
    logger.error(`Status endpoint error: ${err.message}`);
    res.status(500).type('text/plain').send(`reverse proxy (port ${CONFIG.server.port}): error\n`);
  }
});

app.post('/db/c', express.json(), async (req, res) => {
  const key = req.query.key;
  const value = req.body.value;
  if (!key || value === undefined) {
    logger.warn('/db/c missing key or value');
    return res.status(400).json(errorResponse('MISSING_PARAMS', 400, 'need key+value'));
  }

  try {
    const { nodeIndex, leaderPort } = await locateLeaderForKey(key);
    const data = await postJson(`http://localhost:${leaderPort}/db/c`, { key, value });
    logger.info(`/db/c created key=${key} (hash: ${getKeyHash(key)}) at nodeIndex=${nodeIndex}, leaderPort=${leaderPort}`);
    return res.json(successResponse({ key,DB_key: getKeyHash(key), nodeIndex, leaderPort, ...data }));
  } catch (err) {
    logger.error(`/db/c error for key=${key} (hash: ${getKeyHash(key)}): ${err.message}`);
    return res.status(409).json(errorResponse('MISSING_PARAMS', 409, err));
  }
});

app.get('/db/r', async (req, res) => {
  const key = req.query.key;
  if (!key) {
    logger.warn('/db/r missing ?key=');
    return res.status(400).json({ error: 'need ?key=' });
  }

  try {
    const { nodeIndex, leaderPort } = await locateLeaderForKey(key);
    const data = await getJson(`http://localhost:${leaderPort}/data/${encodeURIComponent(key)}`);
    logger.info(`/db/r read key=${key} (hash: ${getKeyHash(key)}) from nodeIndex=${nodeIndex}, leaderPort=${leaderPort}`);
    let parsedValue = data.value;
    try {
      parsedValue = JSON.parse(data.value);
    } catch {
      logger.error(`/db/r error this is not a json format`)
    }
    return res.json({ key,DB_key: getKeyHash(key), nodeIndex, leaderPort, value: parsedValue });
  } catch (err) {
    if (err.status === 404) {
      logger.info(`/db/r key=${key} (hash: ${getKeyHash(key)}) not found`);
      return res.json({ key, error: 'Not found' });
    }
    logger.error(`/db/r error for key=${key}: ${err.message}`);
    return res.status(500).json({ key, error: err.message });
  }
});

// /db/u POST (update)
app.post('/db/u', express.json(), async (req, res) => {
  const key = req.query.key;
  const delta = req.body.value;

  if (!key || delta === undefined) {
    logger.warn('/db/u missing key or value');
    return res.status(400).json({ error: 'need key+value' });
  }

  try {
    const { nodeIndex, leaderPort } = await locateLeaderForKey(key);

    let existing = {};
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 1000);
      const response = await fetch(`http://localhost:${leaderPort}/data/${encodeURIComponent(key)}`, {
        signal: controller.signal
      });
      clearTimeout(timeout);

      if (response.status === 200) {
        const data = await response.json();
        existing = data.value || {};
      } else if (response.status !== 404) {
        const errorText = await response.text();
        logger.warn(`/db/u fetch existing data error: status ${response.status}, text: ${errorText}`);
        return res.status(response.status).type('text/plain').send(errorText);
      }
    } catch (e) {
      logger.error(`/db/u failed to read existing data for key=${key}: ${e.message}`);
      return res.status(500).json({ error: 'Failed to read existing data: ' + e.message });
    }

    const merged = { ...existing, ...delta };

    try {
      const response = await fetch(`http://localhost:${leaderPort}/db/u`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key,DB_key: getKeyHash(key), value: merged })
      });

      const data = await response.json();

      if (!response.ok) {
        logger.warn(`/db/u update failed: ${JSON.stringify(data)}`);
        return res.status(response.status).json(data);
      }

      logger.info(`/db/u updated key=${key} (hash: ${getKeyHash(key)}) at nodeIndex=${nodeIndex}, leaderPort=${leaderPort}`);
      return res.json({ key,DB_key: getKeyHash(key),nodeIndex, leaderPort, ...data, value: merged });

    } catch (e) {
      logger.error(`/db/u update failed: ${e.message}`);
      return res.status(500).json({ error: 'Update failed: ' + e.message });
    }

  } catch (err) {
    logger.error(`/db/u error: ${err.message}`);
    return res.status(500).json({ error: err.message });
  }
});

// CRUD DELETE
app.delete('/db/d', async (req, res) => {
  const key = req.query.key;
  if (!key) {
    logger.warn('/db/d missing ?key=');
    return res.status(400).json({ error: 'need ?key=' });
  }
  try {
    const { nodeIndex, leaderPort } = await locateLeaderForKey(key);
    const url = `http://localhost:${leaderPort}/db/d?key=${encodeURIComponent(key)}`;
    const data = await deleteJson(url);
    logger.info(`/db/d deleted key=${key} (hash: ${getKeyHash(key)}) at nodeIndex=${nodeIndex}, leaderPort=${leaderPort}`);
    return res.json({ key,DB_key: getKeyHash(key), nodeIndex, leaderPort, ...data });
  } catch (err) {
    logger.error(`/db/d error for key=${key}: ${err.message}`);
    return res.status(500).json({ error: err.message });
  }
});

app.get('/stats', async (req, res) => {
  const combinedStats = {
    create: 0,
    read: 0,
    update: 0,
    delete: 0,
  };

  try {
    for (const node of CONFIG.nodes) {
      for (const server of node.servers) {
        try {
          const response = await fetch(`http://localhost:${server.port}/stats`);
          if (!response.ok) {
            logger.warn(`Failed to fetch stats from serverdb port ${server.port}`);
            continue;
          }
          const data = await response.json();

          combinedStats.create += data.stats.create || 0;
          combinedStats.read += data.stats.read || 0;
          combinedStats.update += data.stats.update || 0;
          combinedStats.delete += data.stats.delete || 0;
        } catch (err) {
          logger.warn(`Error fetching stats from port ${server.port}: ${err.message}`);
        }
      }
    }
    res.json({ combinedStats });
  } catch (err) {
    logger.error(`Failed to retrieve stats: ${err.message}`);
    res.status(500).json({ error: 'Failed to retrieve stats', details: err.message });
  }
});

app.get('/get_leaders', async (req, res) => {
  const leaders = [];
  const errors = [];
  const startTime = Date.now();

  try {
    // Check all nodes in parallel
    await Promise.all(CONFIG.nodes.map(async (node, nodeIndex) => {
      for (const server of node.servers) {
        try {
          const controller = new AbortController();
          const timeout = setTimeout(() => controller.abort(), 1000);
          
          const response = await fetch(`http://localhost:${server.port}/status`, {
            signal: controller.signal
          });
          clearTimeout(timeout);

          if (!response.ok) continue;

          const data = await response.json();
          
          if (data.raft?.state === 'leader') {
            leaders.push({
              nodeId: nodeIndex,
              nodeName: node.name,
              leaderPort: server.port,
              term: data.raft.term,
              uptime: data.uptime || 'unknown',
              lastContact: new Date().toISOString()
            });
            break; // Found leader for this node, move to next node
          }
        } catch (err) {
          errors.push({
            nodeId: nodeIndex,
            port: server.port,
            error: err.message
          });
          continue;
        }
      }
    }));

    res.json({
      status: 'success',
      count: leaders.length,
      processingTime: `${Date.now() - startTime}ms`,
      leaders: leaders.sort((a, b) => a.nodeId - b.nodeId),
      errors: errors.length > 0 ? errors : undefined
    });

  } catch (err) {
    logger.error(`/get_leaders error: ${err.message}`);
    res.status(500).json({
      status: 'error',
      error: err.message,
      partialResults: leaders.length > 0 ? leaders : undefined
    });
  }
});
app.post('/stop', async (req, res) => {
  const nodeKey = req.query.key;
  const serverId = req.query.id !== undefined ? parseInt(req.query.id) : null;

  if (!nodeKey) {
    return res.status(400).json({ error: 'Missing node key in query parameter "key"' });
  }

  const nodeId = NODE_NAME_TO_ID[nodeKey] ?? parseInt(nodeKey);
  if (isNaN(nodeId) || nodeId < 0 || nodeId >= CONFIG.nodes.length) {
    return res.status(404).json({ error: `Invalid node identifier: ${nodeKey}` });
  }

  const node = CONFIG.nodes[nodeId];

  // If no serverId provided, stop whole node
  if (serverId === null) {
    const failed = [];
    const succeeded = [];

    for (const server of node.servers) {
      try {
        const response = await fetch(`http://localhost:${server.port}/stop`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' }
        });

        if (response.ok) {
          succeeded.push(server.port);
        } else {
          failed.push({ port: server.port, status: response.status });
        }
      } catch (err) {
        failed.push({ port: server.port, error: err.message });
      }
    }

    const removed = [];
    for (let i = childProcesses.length - 1; i >= 0; i--) {
      const cp = childProcesses[i];
      if (cp.nodeId === nodeId) {
        cp.kill();
        removed.push(cp.pid);
        childProcesses.splice(i, 1);
      }
    }

    return res.json({
      message: `Stop signals sent to all servers in node ${nodeKey}`,
      succeededPorts: succeeded,
      failedPorts: failed,
      killedProcesses: removed
    });
  }

  // Only stop single serverdb (by id)
  if (isNaN(serverId) || serverId < 0 || serverId >= node.servers.length) {
    return res.status(400).json({ error: `Invalid server ID ${serverId} for node ${nodeKey}` });
  }

  const targetServer = node.servers[serverId];
  let result = { attemptedPort: targetServer.port, success: false, error: null };

  try {
    const response = await fetch(`http://localhost:${targetServer.port}/stop`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    });

    if (response.ok) {
      result.success = true;
    } else {
      result.error = `Received HTTP ${response.status}`;
    }
  } catch (err) {
    result.error = err.message;
  }

  return res.json({
    message: `Attempted to stop server ${serverId} in node ${nodeKey}`,
    result
  });
});

app.post('/shutdown', (req, res) => {
  res.send('Shutting down...');
  logger.info('Shutdown requested. Cleaning up...');

  childProcesses.forEach(child => {
    child.kill();
  });

  server.close(() => {
    logger.info('Reverse proxy shut down cleanly.');
    process.exit(0);
  });

  setTimeout(() => {
    logger.warn('Force exiting...');
    process.exit(1);
  }, 5000);
});

app.use((err, req, res, next) => {
  logger.error(err.stack);
  res.status(500).json({ error: 'Internal Server Error' });
});

const server = app.listen(CONFIG.server.port, () => {
  logger.info(`Reverse Proxy running on port ${CONFIG.server.port}`);
});

server.on('error', (err) => {
  logger.error('Server error:', err);
  process.exit(1);
});