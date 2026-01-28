# Edge Tunnel MVP

This document describes the edge-first architecture for SuperNavi, enabling seamless tile loading through a single public endpoint (https://app.supernavi.app) with automatic fallback between local edge and cloud preview.

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────┐
│                        Browser (Frontend)                            │
│                    https://app.supernavi.app                         │
│                                                                      │
│   ┌────────────────────────────────────────────────────────────┐    │
│   │  useEdgeFirstTileSource composable                         │    │
│   │                                                            │    │
│   │  1. Check /edge/{agentId}/v1/health (500ms timeout)       │    │
│   │  2a. If OK → load from /edge/{agentId}/v1/slides/...      │    │
│   │  2b. If fail → load from /preview/{slideId}/...           │    │
│   └────────────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────────────┘
                                │
                                │ HTTPS (same-origin)
                                ▼
┌─────────────────────────────────────────────────────────────────────┐
│                    Cloud Server (supernavi_cloud)                    │
│                                                                      │
│   ┌──────────────────────┐    ┌──────────────────────┐             │
│   │  /edge/:agentId/*    │    │  /preview/:slideId/* │             │
│   │  (reverse proxy)     │    │  (S3 stream proxy)   │             │
│   │                      │    │                      │             │
│   │  Forwards requests   │    │  Streams tiles from  │             │
│   │  through WebSocket   │    │  Wasabi S3 storage   │             │
│   │  tunnel to edge      │    │                      │             │
│   └──────────┬───────────┘    └──────────┬───────────┘             │
│              │                           │                          │
│              │ WebSocket                 │ HTTPS                    │
│              │ (tunnel)                  ▼                          │
│              │                    ┌─────────────┐                   │
│              │                    │   Wasabi    │                   │
│              │                    │     S3      │                   │
│              │                    └─────────────┘                   │
└──────────────┼──────────────────────────────────────────────────────┘
               │
               │ WebSocket (outbound from edge)
               ▼
┌─────────────────────────────────────────────────────────────────────┐
│                      Edge Agent (supernavi_edge)                     │
│                         (Local Network)                              │
│                                                                      │
│   ┌──────────────────────┐    ┌──────────────────────┐             │
│   │   Tunnel Client      │    │   Fastify Server     │             │
│   │                      │    │                      │             │
│   │   Connects to cloud  │───▶│   /v1/health         │             │
│   │   Receives requests  │    │   /v1/slides/:id/*   │             │
│   │   Uses inject() to   │    │   (tiles, manifest,  │             │
│   │   execute locally    │    │    thumbnail)        │             │
│   └──────────────────────┘    └──────────────────────┘             │
│                                          │                          │
│                                          ▼                          │
│                                   ┌─────────────┐                   │
│                                   │  Local      │                   │
│                                   │  Storage    │                   │
│                                   │  (SVS/DZI)  │                   │
│                                   └─────────────┘                   │
└─────────────────────────────────────────────────────────────────────┘
```

## Key Principles

1. **Single Public Endpoint**: The browser only accesses `https://app.supernavi.app`. No direct access to localhost, local IP, or S3.

2. **Edge-First**: When the edge agent is available, full-resolution tiles are served from local storage for optimal performance.

3. **Automatic Fallback**: If the edge is unavailable, the system automatically falls back to cloud preview (lower resolution but always available).

4. **Same-Origin**: All requests are same-origin, avoiding CORS issues and simplifying security.

## Environment Variables

### Cloud Server (supernavi_cloud)

```bash
# Required: Token for edge agent authentication
EDGE_TUNNEL_TOKEN=your-secure-token-here

# Optional: Timeouts for reverse proxy
EDGE_TUNNEL_HEALTH_TIMEOUT_MS=2000   # Default: 2000ms
EDGE_TUNNEL_TILE_TIMEOUT_MS=8000     # Default: 8000ms

# Required: S3/Wasabi configuration (for cloud preview)
S3_ENDPOINT=https://s3.eu-central-1.wasabisys.com
S3_REGION=eu-central-1
S3_BUCKET=supernavi-eu
S3_ACCESS_KEY=your-access-key
S3_SECRET_KEY=your-secret-key
```

### Edge Agent (supernavi_edge)

```bash
# Required: Cloud tunnel URL
CLOUD_TUNNEL_URL=wss://app.supernavi.app/edge/connect

# Required: Authentication token (must match cloud)
EDGE_TUNNEL_TOKEN=your-secure-token-here

# Required: Unique identifier for this edge agent
EDGE_AGENT_ID=lab01
```

### Frontend (supernavi_frontend)

```bash
# Optional: Edge agent ID (enables edge-first loading)
VITE_EDGE_AGENT_ID=lab01

# Optional: Health check timeout
VITE_EDGE_HEALTH_TIMEOUT_MS=500
```

## API Endpoints

### Cloud Server

| Endpoint | Description |
|----------|-------------|
| `GET /edge/connect` | WebSocket endpoint for edge agents |
| `GET /edge/status` | Status of connected agents (debug) |
| `ANY /edge/:agentId/*` | Reverse proxy to edge agent |
| `GET /preview/:slideId/manifest.json` | Slide manifest (rewritten URLs) |
| `GET /preview/:slideId/thumb.jpg` | Slide thumbnail |
| `GET /preview/:slideId/tiles/:level/:x_y.jpg` | Tile image |

### Edge Agent

| Endpoint | Description |
|----------|-------------|
| `GET /v1/health` | Health check with tunnel status |
| `GET /v1/slides/:slideId/manifest` | Slide manifest |
| `GET /v1/slides/:slideId/thumb` | Slide thumbnail |
| `GET /v1/slides/:slideId/tiles/:z/:x/:y.jpg` | Tile image |

## Testing

### 1. Test Cloud Preview (without edge)

```bash
# Check if preview manifest exists
curl -s https://app.supernavi.app/preview/<slideId>/manifest.json | jq .

# Fetch a tile
curl -I https://app.supernavi.app/preview/<slideId>/tiles/6/0_0.jpg
```

### 2. Test Edge Connection

```bash
# On cloud: check connected agents
curl -s https://app.supernavi.app/edge/status | jq .

# Expected:
# {
#   "connectedAgents": 1,
#   "agents": [
#     {
#       "agentId": "lab01",
#       "connectedAt": "2024-01-15T10:00:00.000Z",
#       "lastSeen": "2024-01-15T10:05:00.000Z"
#     }
#   ]
# }
```

### 3. Test Edge Proxy

```bash
# Health check through tunnel
curl -s https://app.supernavi.app/edge/lab01/v1/health | jq .

# Expected:
# {
#   "status": "ok",
#   "version": "0.1.0",
#   "mode": "local",
#   "timestamp": "2024-01-15T10:00:00.000Z",
#   "tunnel": {
#     "configured": true,
#     "connected": true,
#     "agentId": "lab01"
#   }
# }

# Fetch a tile through tunnel
curl -I https://app.supernavi.app/edge/lab01/v1/slides/<slideId>/tiles/10/5/3.jpg
```

### 4. Test Frontend Behavior

1. Open browser DevTools Network tab
2. Navigate to viewer page
3. Observe requests:
   - If edge available: requests go to `/edge/lab01/v1/slides/...`
   - If edge unavailable: requests go to `/preview/...`
4. Check the tile source badge (LOCAL/CLOUD indicator)

## Security

### Authentication

- Edge agents authenticate with a pre-shared token (`EDGE_TUNNEL_TOKEN`)
- Token is validated on WebSocket connection handshake
- Connections without valid token are rejected with 4001 code

### Request Validation

- `agentId` must be alphanumeric with dashes/underscores (1-64 chars)
- Headers are filtered (no Host, Connection, etc.)
- Body size is limited (25MB default)

### Same-Origin Protection

- All requests go through the cloud domain
- No CORS needed (same-origin)
- S3 URLs are never exposed to browser

## Troubleshooting

### Edge Not Connecting

1. Check cloud logs for connection attempts
2. Verify `EDGE_TUNNEL_TOKEN` matches on both sides
3. Verify `CLOUD_TUNNEL_URL` is correct (wss:// protocol)
4. Check firewall allows outbound WebSocket

### Edge Timeout

1. Check edge agent is processing requests (logs)
2. Increase timeout: `EDGE_TUNNEL_TILE_TIMEOUT_MS=15000`
3. Check edge server load (CPU, memory)

### Preview Tiles 404

1. Verify slide has `hasPreview: true` in database
2. Check `PreviewAsset` exists for the slide
3. Verify tiles exist in S3 at expected path
4. Check S3 credentials are correct

### Fallback Not Working

1. Verify `VITE_EDGE_AGENT_ID` is set in frontend
2. Check browser console for edge health check result
3. Verify cloud preview endpoints are accessible

## Performance Considerations

- Edge health check timeout is 500ms by default (fast fallback)
- Tile requests have 8s timeout (allows large tiles)
- Health checks have 2s timeout
- WebSocket ping/pong every 30s (keeps connection alive)
- Reconnection with exponential backoff (1s → 30s max)
