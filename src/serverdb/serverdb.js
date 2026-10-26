const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const RaftNode = require('./raft');
const CONFIG = require('../../etc/config.json');
const axios = require('axios');
const logger = require('../common/logger/logger');

const app = express();
app.use(express.json());

const NODE_ID = parseInt(process.env.NODE_ID);
const SERVER_ID = parseInt(process.env.SERVER_ID);
const PORT = process.env.PORT;
const DATA_DIR = path.resolve(__dirname, '../../DB-data');

const startTime = Date.now();
let isStopping = false;
const stats = { create: 0, read: 0, update: 0, delete: 0 };

const peers = CONFIG.nodes[NODE_ID].servers
  .filter(s => s.id !== SERVER_ID)
  .map(s => `http://${s.host}:${s.port}`);

function ensureShardDirs(nodeId, serverId) {
  const dn = `dn${String(nodeId).padStart(2, '0')}`;
  const sn = `s${String(serverId).padStart(2, '0')}`;
  const dirPath = path.join(DATA_DIR, dn, sn);
  fs.mkdirSync(dirPath, { recursive: true });
}

function getShardPath(key, nodeId, serverId) {
  const dn = `dn${String(nodeId).padStart(2, '0')}`;
  const sn = `s${String(serverId).padStart(2, '0')}`;
  const filename = crypto.createHash('md5').update(key).digest('hex');
  return path.join(DATA_DIR, dn, sn, filename);
}

ensureShardDirs(NODE_ID, SERVER_ID);

const raft = new RaftNode({
  nodeId: NODE_ID,
  serverId: SERVER_ID,
  peers,
  onLeaderChange: (leaderId, term) => {
    logger.info(`Leader changed: Server ${PORT} is leader at term ${term}`);
  }
});

app.post('/raft/request-vote', (req, res) => raft.handleRequestVote(req, res));
app.post('/raft/heartbeat', (req, res) => raft.handleHeartbeat(req, res));

// Read key
app.get('/data/:key', (req, res) => {
  stats.read++;
  const key = req.params.key;
  try {
    const filePath = getShardPath(key, NODE_ID, SERVER_ID);
    if (!fs.existsSync(filePath)) {
      logger.warn(`Read failed: Key '${key}' not found`);
      return res.status(404).json({ error: `Key '${key}' not found` });
    }
    const value = fs.readFileSync(filePath, 'utf8');
    logger.info('Read key success', { key, nodeId: NODE_ID, serverPort: PORT });
    res.json({
      status: 'ok',
      key,
      value,
      serverInfo: {
        nodeId: NODE_ID,
        port: PORT,
        raft: {
          term: raft.currentTerm,
          state: raft.state,
          leaderId: raft.leaderId ?? null,
        },
      },
    });
  } catch (err) {
    logger.error('Read error', { key, error: err.message });
    res.status(500).json({ error: 'Failed to read DB' });
  }
});

// Create (write) key
app.post('/db/c', async (req, res) => {
  if (raft.state !== 'leader') {
    logger.warn('Write attempt rejected: Not leader');
    return res.status(403).send('Only the leader can handle writes');
  }

  const { key, value } = req.body;
  if (!key || value === undefined) {
    logger.warn('Create failed: Key or value missing');
    return res.status(400).json({ error: 'Key and value required' });
  }

  stats.create++;
  try {
    const preparePayload = { key, value };
    const prepareResults = await Promise.all(peers.map(peer =>
      axios.post(`${peer}/2pc/prepare`, preparePayload).catch(() => null)
    ));

    if (prepareResults.some(resp => !resp || resp.status !== 200)) {
      logger.error('Create prepare phase failed', { key, prepareResults });
      return res.status(500).send('Prepare phase failed, aborting.');
    }

    const filePath = getShardPath(key, NODE_ID, SERVER_ID);
    if (fs.existsSync(filePath)) {
      logger.warn('Create failed: Key already exists', { key });
      return res.status(409).json({ error: `Key '${key}' already exists` });
    }

    fs.writeFileSync(filePath, JSON.stringify(value), 'utf8');

    await Promise.all(peers.map(peer =>
      axios.post(`${peer}/2pc/commit`, preparePayload).catch(() => null)
    ));

    logger.info('Create committed successfully', { key, value });
    res.json({ status: 'committed', key, value });
  } catch (err) {
    logger.error('Create failed', { key, error: err.message });
    res.status(500).send('Commit failed: ' + err.message);
  }
});

// Update key
app.post('/db/u', async (req, res) => {
  if (raft.state !== 'leader') {
    logger.warn('Update attempt rejected: Not leader');
    return res.status(403).send('Only the leader can handle updates');
  }

  const { key, value } = req.body;
  const filePath = getShardPath(key, NODE_ID, SERVER_ID);
  if (!fs.existsSync(filePath)) {
    logger.warn('Update failed: Key not found', { key });
    return res.status(404).json({ error: `Key '${key}' not found` });
  }

  stats.update++;
  try {
    const preparePayload = { key, value };
    const prepareResults = await Promise.all(peers.map(peer =>
      axios.post(`${peer}/2pc/prepare`, preparePayload).catch(() => null)
    ));

    if (prepareResults.some(resp => !resp || resp.status !== 200)) {
      logger.error('Update prepare phase failed', { key, prepareResults });
      return res.status(500).send('Prepare phase failed, aborting.');
    }

    fs.writeFileSync(filePath, JSON.stringify(value), 'utf8');

    await Promise.all(peers.map(peer =>
      axios.post(`${peer}/2pc/commit`, preparePayload).catch(() => null)
    ));

    logger.info('Update committed successfully', { key, value });
    res.json({ status: 'updated', key, value });
  } catch (err) {
    logger.error('Update failed', { key, error: err.message });
    res.status(500).send('Update failed: ' + err.message);
  }
});

// Delete key
app.delete('/db/d', async (req, res) => {
  if (raft.state !== 'leader') {
    logger.warn('Delete attempt rejected: Not leader');
    return res.status(403).send('Only leader can handle deletes');
  }

  const key = req.query.key;
  if (!key) {
    logger.warn('Delete failed: Missing key query parameter');
    return res.status(400).json({ error: 'Missing key query parameter' });
  }

  const filePath = getShardPath(key, NODE_ID, SERVER_ID);
  if (!fs.existsSync(filePath)) {
    logger.warn('Delete failed: Key not found', { key });
    return res.status(404).json({ error: `Key '${key}' not found` });
  }

  stats.delete++;
  try {
    const prepareResponses = await Promise.all(peers.map(peer =>
      axios.post(`${peer}/2pc/prepare-delete`, { key }).catch(() => null)
    ));

    if (prepareResponses.some(resp => !resp || resp.status !== 200)) {
      logger.error('Delete prepare phase failed', { key, prepareResponses });
      return res.status(500).send('Prepare phase failed, aborting.');
    }

    fs.unlinkSync(filePath);

    await Promise.all(peers.map(peer =>
      axios.post(`${peer}/2pc/commit-delete`, { key }).catch(() => null)
    ));

    logger.info('Delete committed successfully', { key });
    res.json({ status: 'deleted', key });
  } catch (err) {
    logger.error('Delete failed', { key, error: err.message });
    res.status(500).json({ error: 'Delete failed: ' + err.message });
  }
});

// 2PC Endpoints
app.post('/2pc/prepare', (req, res) => res.sendStatus(200));
app.post('/2pc/prepare-delete', (req, res) => res.sendStatus(200));

app.post('/2pc/commit', (req, res) => {
  try {
    const { key, value } = req.body;
    const filePath = getShardPath(key, NODE_ID, SERVER_ID);
    fs.writeFileSync(filePath, JSON.stringify(value), 'utf8');
    logger.info('2PC commit completed', { key, value });
    res.sendStatus(200);
  } catch (err) {
    logger.error('2PC commit failed', { error: err.message });
    res.status(500).send('Commit failed');
  }
});

app.post('/2pc/commit-delete', (req, res) => {
  try {
    const { key } = req.body;
    const filePath = getShardPath(key, NODE_ID, SERVER_ID);
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
    logger.info('2PC commit-delete completed', { key });
    res.sendStatus(200);
  } catch (err) {
    logger.error('2PC commit-delete failed', { error: err.message });
    res.status(500).send('Commit delete failed');
  }
});

app.get('/status', (req, res) => {
  const uptimeMs = Date.now() - startTime;
  const uptimeSeconds = Math.floor(uptimeMs / 1000);
  try {
    res.json({
      status: 'healthy',
      port: PORT,
      uptime: uptimeSeconds,
      raft: {
        state: raft.state,
        term: raft.currentTerm,
        leaderId: raft.leaderId ?? null,
      },
    });
  } catch (err) {
    logger.error('Status check failed', { error: err.message });
    res.status(500).json({ status: 'unhealthy', error: err.message });
  }
});

app.get('/stats', (req, res) => {
  res.json({ stats });
});

app.post('/stop', (req, res) => {
  res.json({ status: 'stopping', pid: process.pid });
  logger.info('Shutdown signal received. Exiting...');
  process.exit(0);
});

const server = app.listen(PORT, () => {
  logger.info(`ServerDB ${SERVER_ID} running on port ${PORT} with Raft state ${raft.state}`);
});

process.on('SIGINT', () => {
  raft.shutdown();
  server.close(() => {
    logger.info(`ServerDB ${SERVER_ID} shutting down.`);
    process.exit(0);
  });
});