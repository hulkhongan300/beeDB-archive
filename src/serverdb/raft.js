const axios = require('axios');
class RaftNode {
  constructor({ nodeId, serverId, peers, onLeaderChange }) {
    this.nodeId = nodeId;       // node index (optional)
    this.serverId = serverId;   // server index in node
    this.peers = peers;         // array of peer URLs (http://host:port)
    this.onLeaderChange = onLeaderChange;
    this.state = 'follower';  // follower, candidate, leader
    this.leaderId = null; 
    this.currentTerm = 0;
    this.votedFor = null;
    this.votesReceived = 0;
    this.electionTimeout = null;
    this.heartbeatInterval = null;
    this.resetElectionTimeout();
  }
  resetElectionTimeout() {
    if (this.electionTimeout) clearTimeout(this.electionTimeout);
    const timeout = 150 + Math.random() * 150;
    this.electionTimeout = setTimeout(() => {
      const now = Date.now();
      const sinceLastHeartbeat = now - (this.lastHeartbeat || 0);
      if (this.state !== 'leader' && sinceLastHeartbeat > timeout) {
        this.startElection();
      } else {
        this.state = 'follower';
        this.resetElectionTimeout();
      }
    }, timeout);
  }
  async startElection() {
    this.state = 'candidate';
    this.currentTerm++;
    this.votedFor = this.serverId;
    this.votesReceived = 1; 
    const voteRequests = this.peers.map(peer => 
      axios.post(`${peer}/raft/request-vote`, {
        term: this.currentTerm,
        candidateId: this.serverId
      }).then(res => res.data.voteGranted)
      .catch(() => false)
    );
    const results = await Promise.all(voteRequests);
    results.forEach(granted => {
      if (granted) this.votesReceived++;
    });
    if (this.votesReceived > this.peers.length / 2) {
      this.becomeLeader();
    } else {
      this.resetElectionTimeout();
    }
  }
  becomeLeader() {
    this.state = 'leader';
    if (this.onLeaderChange) this.onLeaderChange(this.serverId, this.currentTerm);
    this.startHeartbeat();
  }
  startHeartbeat() {
    if (this.heartbeatInterval) clearInterval(this.heartbeatInterval);
    this.heartbeatInterval = setInterval(() => this.sendHeartbeats(), 50);
  }
  async sendHeartbeats() {
    this.peers.forEach(async peer => {
      try {
        await axios.post(`${peer}/raft/heartbeat`, {
          term: this.currentTerm,
          leaderId: this.serverId
        });
      } catch {
      }
    });
  }
  async handleRequestVote(req, res) {
    const { term, candidateId } = req.body;
    if (term < this.currentTerm) {
      return res.json({ term: this.currentTerm, voteGranted: false });
    }
    if (term > this.currentTerm) {
      this.currentTerm = term;
      this.votedFor = null;
      this.state = 'follower';
    }
    if (this.votedFor === null || this.votedFor === candidateId) {
      this.votedFor = candidateId;
      this.resetElectionTimeout();
      return res.json({ term: this.currentTerm, voteGranted: true });
    }
    return res.json({ term: this.currentTerm, voteGranted: false });
  }
  async handleHeartbeat(req, res) {
    const { term, leaderId } = req.body;
    if (term < this.currentTerm) {
      return res.json({ success: false, term: this.currentTerm });
    }
    if (term > this.currentTerm || this.state !== 'follower') {
      this.currentTerm = term;
      this.state = 'follower';
      this.votedFor = null;
    }
    this.leaderId = leaderId;
    this.lastHeartbeat = Date.now();
    this.resetElectionTimeout();
    return res.json({ success: true, term: this.currentTerm });
  }
  getStatus() {
    return {
      state: this.state,
      currentTerm: this.currentTerm,
      votedFor: this.votedFor
    };
  }
  shutdown() {
    if (this.electionTimeout) clearTimeout(this.electionTimeout);
    if (this.heartbeatInterval) clearInterval(this.heartbeatInterval);
  }
}
module.exports = RaftNode;