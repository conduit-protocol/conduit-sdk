class RoomManager {
  constructor(options = {}) {
    this._maxRoomSize = options.maxRoomSize !== undefined ? options.maxRoomSize : Infinity;
    this._rooms = new Map(); // roomId -> Map(clientId -> ws)
    this._clientRooms = new Map(); // clientId -> Set(roomId)
  }

  _ensureRoom(roomId) {
    let room = this._rooms.get(roomId);
    if (!room) {
      room = new Map();
      this._rooms.set(roomId, room);
    }
    return room;
  }

  _ensureClientRooms(clientId) {
    let rooms = this._clientRooms.get(clientId);
    if (!rooms) {
      rooms = new Set();
      this._clientRooms.set(clientId, rooms);
    }
    return rooms;
  }

  /**
   * Join a room. If the client is already in the room, updates the socket reference.
   * Returns { ok: true } on success, or { ok: false, reason: 'ROOM_FULL' } if capacity is exceeded.
   *
   * @param {string} clientId - Unique client identifier
   * @param {string} roomId   - Room to join
   * @param {object} ws       - WebSocket-like object with a `send` method
   */
  join(clientId, roomId, ws) {
    // Fetch existing room without auto-creating, so we can capacity-check first.
    const existing = this._rooms.get(roomId);

    if (existing) {
      // Re-joining client — update socket ref, no capacity check needed.
      if (existing.has(clientId)) {
        existing.set(clientId, ws);
        return { ok: true };
      }
      // New client entering an existing room — enforce capacity.
      if (existing.size >= this._maxRoomSize) {
        return { ok: false, reason: 'ROOM_FULL' };
      }
      existing.set(clientId, ws);
    } else {
      // Room does not exist yet; capacity check is trivially passed for size >= 1.
      if (this._maxRoomSize < 1) {
        return { ok: false, reason: 'ROOM_FULL' };
      }
      this._rooms.set(roomId, new Map([[clientId, ws]]));
    }

    this._ensureClientRooms(clientId).add(roomId);
    return { ok: true };
  }

  /**
   * Remove a client from a specific room. Cleans up empty rooms and empty
   * client-room sets automatically.
   *
   * @param {string} clientId
   * @param {string} roomId
   */
  leave(clientId, roomId) {
    const room = this._rooms.get(roomId);
    if (room) {
      room.delete(clientId);
      if (room.size === 0) {
        this._rooms.delete(roomId);
      }
    }
    const clientRooms = this._clientRooms.get(clientId);
    if (clientRooms) {
      clientRooms.delete(roomId);
      if (clientRooms.size === 0) {
        this._clientRooms.delete(clientId);
      }
    }
  }

  /**
   * Remove a client from **every** room it belongs to in a single sweep.
   * More efficient than calling `leave()` per room when a connection drops.
   *
   * @param {string} clientId
   */
  disconnectClient(clientId) {
    const clientRooms = this._clientRooms.get(clientId);
    if (!clientRooms) return;

    for (const roomId of clientRooms) {
      const room = this._rooms.get(roomId);
      if (room) {
        room.delete(clientId);
        if (room.size === 0) {
          this._rooms.delete(roomId);
        }
      }
    }
    this._clientRooms.delete(clientId);
  }

  /**
   * Fan-out a message to every client currently in a room.
   * Iterates the room's Map exactly once — callers no longer need to
   * fetch and loop the room themselves.
   *
   * @param {string}        roomId
   * @param {string|Buffer} data   - Passed verbatim to each ws.send()
   */
  broadcast(roomId, data) {
    const room = this._rooms.get(roomId);
    if (!room) return;
    for (const ws of room.values()) {
      ws.send(data);
    }
  }

  /**
   * O(1) room size accessor.
   *
   * @param {string} roomId
   * @returns {number} Number of clients in the room, or 0 if it does not exist.
   */
  getRoomSize(roomId) {
    const room = this._rooms.get(roomId);
    return room ? room.size : 0;
  }

  /**
   * Return the client Map for a room (clientId → ws).
   * Returns an empty Map if the room does not exist — never returns null/undefined.
   *
   * @param {string} roomId
   * @returns {Map<string, object>}
   */
  getClients(roomId) {
    return this._rooms.get(roomId) ?? new Map();
  }
}

module.exports = { RoomManager };
