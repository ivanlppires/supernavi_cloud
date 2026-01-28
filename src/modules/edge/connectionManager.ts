import type { WebSocket } from 'ws';

/**
 * HTTP request forwarded through the tunnel
 */
export interface TunnelHttpRequest {
  type: 'http_request';
  requestId: string;
  method: string;
  url: string; // Path after /edge/:agentId, e.g., "/v1/health"
  headers: Record<string, string>;
  bodyBase64?: string;
}

/**
 * HTTP response from the edge agent
 */
export interface TunnelHttpResponse {
  type: 'http_response';
  requestId: string;
  statusCode: number;
  headers: Record<string, string>;
  bodyBase64?: string;
}

/**
 * Edge connection with metadata
 */
interface EdgeConnection {
  ws: WebSocket;
  agentId: string;
  connectedAt: Date;
  lastSeen: Date;
  pendingRequests: Map<string, PendingRequest>;
}

/**
 * Pending HTTP request awaiting response
 */
interface PendingRequest {
  resolve: (response: TunnelHttpResponse) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  startedAt: number;
}

/**
 * Active edge connections indexed by agentId
 */
const edgeConnections = new Map<string, EdgeConnection>();

/**
 * Register a new edge connection
 */
export function registerEdge(agentId: string, ws: WebSocket): void {
  // Close existing connection if any
  const existing = edgeConnections.get(agentId);
  if (existing) {
    console.log(`[EdgeManager] Replacing existing connection for agent: ${agentId}`);
    existing.ws.close(1000, 'Replaced by new connection');
    // Reject all pending requests
    for (const [, pending] of existing.pendingRequests) {
      clearTimeout(pending.timer);
      pending.reject(new Error('Connection replaced'));
    }
  }

  edgeConnections.set(agentId, {
    ws,
    agentId,
    connectedAt: new Date(),
    lastSeen: new Date(),
    pendingRequests: new Map(),
  });

  console.log(`[EdgeManager] Agent registered: ${agentId}`);
}

/**
 * Unregister an edge connection
 */
export function unregisterEdge(agentId: string): void {
  const connection = edgeConnections.get(agentId);
  if (connection) {
    // Reject all pending requests
    for (const [, pending] of connection.pendingRequests) {
      clearTimeout(pending.timer);
      pending.reject(new Error('Edge disconnected'));
    }
    edgeConnections.delete(agentId);
    console.log(`[EdgeManager] Agent unregistered: ${agentId}`);
  }
}

/**
 * Update last seen timestamp for an agent (called on pong)
 */
export function updateLastSeen(agentId: string): void {
  const connection = edgeConnections.get(agentId);
  if (connection) {
    connection.lastSeen = new Date();
  }
}

/**
 * Check if an agent is connected
 */
export function isAgentConnected(agentId: string): boolean {
  return edgeConnections.has(agentId);
}

/**
 * Get connection info for an agent
 */
export function getConnectionInfo(agentId: string): { connectedAt: Date; lastSeen: Date } | null {
  const connection = edgeConnections.get(agentId);
  if (!connection) return null;
  return {
    connectedAt: connection.connectedAt,
    lastSeen: connection.lastSeen,
  };
}

/**
 * Get all connected agent IDs
 */
export function getConnectedAgents(): string[] {
  return Array.from(edgeConnections.keys());
}

/**
 * Send an HTTP request through the tunnel and wait for response
 */
export async function sendHttpRequest(
  agentId: string,
  request: Omit<TunnelHttpRequest, 'type'>,
  timeoutMs: number = 8000
): Promise<TunnelHttpResponse> {
  const connection = edgeConnections.get(agentId);
  if (!connection) {
    throw new Error(`Agent ${agentId} is not connected`);
  }

  const tunnelRequest: TunnelHttpRequest = {
    type: 'http_request',
    ...request,
  };

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      connection.pendingRequests.delete(request.requestId);
      reject(new Error(`Request timeout after ${timeoutMs}ms`));
    }, timeoutMs);

    connection.pendingRequests.set(request.requestId, {
      resolve,
      reject,
      timer,
      startedAt: Date.now(),
    });

    try {
      connection.ws.send(JSON.stringify(tunnelRequest));
    } catch (err) {
      clearTimeout(timer);
      connection.pendingRequests.delete(request.requestId);
      reject(new Error(`Failed to send request: ${err}`));
    }
  });
}

/**
 * Handle an HTTP response from an edge agent
 */
export function handleHttpResponse(agentId: string, response: TunnelHttpResponse): boolean {
  const connection = edgeConnections.get(agentId);
  if (!connection) {
    console.warn(`[EdgeManager] Received response for unknown agent: ${agentId}`);
    return false;
  }

  const pending = connection.pendingRequests.get(response.requestId);
  if (!pending) {
    console.warn(`[EdgeManager] Received response for unknown request: ${response.requestId}`);
    return false;
  }

  clearTimeout(pending.timer);
  connection.pendingRequests.delete(response.requestId);

  const durationMs = Date.now() - pending.startedAt;
  console.log(`[EdgeManager] Request ${response.requestId} completed in ${durationMs}ms with status ${response.statusCode}`);

  pending.resolve(response);
  return true;
}

/**
 * Get the WebSocket for an agent (for ping/pong handling)
 */
export function getWebSocket(agentId: string): WebSocket | null {
  return edgeConnections.get(agentId)?.ws ?? null;
}

export default {
  registerEdge,
  unregisterEdge,
  updateLastSeen,
  isAgentConnected,
  getConnectionInfo,
  getConnectedAgents,
  sendHttpRequest,
  handleHttpResponse,
  getWebSocket,
};
