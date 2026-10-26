<div align="center">

![Universidade Portucalense](logo_upt.png)

# 🐝 beeDB

**A distributed key-value database built with Node.js**

*Distributed Systems — Universidade Portucalense*

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-18%2B-green)](https://nodejs.org)

</div>

---

## 📖 About

**beeDB** is a distributed key-value database implemented in Node.js. It splits data across multiple nodes (**sharding**) and ensures fault tolerance and strong consistency through the **Raft** consensus protocol and **Two-Phase Commit (2PC)**.

Each key-value pair is stored as a file on the filesystem, named after the **MD5 hash** of the key. The architecture scales horizontally and handles individual server failures without compromising data integrity. A **reverse proxy** routes requests to the correct node based on the key hash.

> [!NOTE]
> This project was developed as part of the Distributed Systems course at Universidade Portucalense. For the full technical report, see [`Trabalho_SD.md`](Trabalho_SD.md).

---

## 🏗️ Architecture

```
                        ┌─────────────────┐
      HTTP Requests ──► │  Reverse Proxy  │  (port 4000)
                        │  MD5 key routing│
                        └────────┬────────┘
                                 │
               ┌─────────────────┼─────────────────┐
               │                 │                 │
        ┌──────▼──────┐  ┌──────▼──────┐  ┌──────▼──────┐
        │  Data Node  │  │  Data Node  │  │  Data Node  │
        │  (shard 1)  │  │  (shard 2)  │  │  (shard N)  │
        └──────┬──────┘  └──────┬──────┘  └──────┬──────┘
               │                │                 │
        ┌──────▼──────┐         │          ┌──────▼──────┐
        │  ServerDB   │         │          │  ServerDB   │
        │  (Raft +    │         │          │  (Raft +    │
        │   2PC)      │         │          │   2PC)      │
        └─────────────┘         │          └─────────────┘
                         ┌──────▼──────┐
                         │  ServerDB   │
                         │  (Raft +    │
                         │   2PC)      │
                         └─────────────┘
```

| Component | Description |
|-----------|-------------|
| **Reverse Proxy** | Entry point of the system. Routes requests to the correct data node via MD5 key hash. Exposes `/status` and `/stats`. |
| **Data Nodes** | Represent database partitions. Expose REST APIs for CRUD operations. |
| **ServerDB** | Handles local file storage, Raft leader election, and 2PC replication. |
| **Raft** | Distributed consensus for leader election. Only the leader can write. |
| **2PC** | Guarantees all replicas apply operations consistently (prepare → commit / rollback). |

---

## ⚙️ Installation

### Prerequisites

- [Node.js](https://nodejs.org) v18 or higher
- `npm` (comes with Node.js)
- `forever` — process manager for the background server

### 1. Install `forever` globally

```bash
npm install -g forever
```

### 2. Clone the repository

```bash
git clone https://github.com/your-org/beeDB.git
cd beeDB
```


---

## 🚀 Usage

All interaction with beeDB is done through the `beeDB.js` CLI tool located in the `bin/` directory.

```bash
cd bin
node beeDB.js <command>
```

### Commands

| Command | Description |
|---------|-------------|
| `start` | Start the beeDB server in the background |
| `stop` | Gracefully shut down the server |
| `restart` | Stop and start the server again |
| `status` | Show the current status of the running server |
| `stats` | Display runtime statistics (requests, nodes, etc.) |
| `check-deps` | Install missing `npm` dependencies across all modules |
| `clean` | Remove all data, logs, and node_modules (**destructive!**) |

### Examples

```bash
# Start the database server
node beeDB.js start

# Check if it's running
node beeDB.js status

# View runtime stats
node beeDB.js stats

# Restart the server
node beeDB.js restart

# Stop the server gracefully
node beeDB.js stop
```

> [!CAUTION]
> `node beeDB.js clean` will permanently delete all stored data (`DB-data/`), all logs (`log/`), and all `node_modules`. Use with care.

### REST API

Once the server is running, the reverse proxy is available at `http://localhost:4000`.

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/status` | Server status |
| `GET` | `/stats` | Runtime statistics |
| `GET` | `/kv/:key` | Retrieve a value by key |
| `POST` | `/kv/:key` | Create or update a key-value pair |
| `DELETE` | `/kv/:key` | Delete a key-value pair |
| `POST` | `/shutdown` | Trigger graceful shutdown |

---

## 👥 Authors

| Name | Student ID | GitHub |
|------|-----------|--------|
| Afonso Calisto | 48096 | [@hulkhongan300](https://github.com/hulkhongan300) |
| Guilherme Russo | 47653 | [@GuiRusso802](https://github.com/GuiRusso802) |
| Duarte Ferreira | 47784 | — |
| Ronaldo Leal | 47564 | — |

---

## 📄 License

This project is licensed under the **MIT License** — see the [LICENSE](LICENSE) file for details.
