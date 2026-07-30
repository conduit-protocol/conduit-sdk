import { expect, test, describe } from 'vitest';
import { RoomManager } from '../src/room-manager.js';
import { handleJoin, handleClose, roomManager } from '../src/server.js';

describe('RoomManager', () => {
  test('join under capacity returns ok: true', () => {
    const manager = new RoomManager({ maxRoomSize: 2 });
    const ws1 = { send: () => {} };
    const ws2 = { send: () => {} };

    expect(manager.join('client1', 'room1', ws1)).toEqual({ ok: true });
    expect(manager.join('client2', 'room1', ws2)).toEqual({ ok: true });
  });

  test('join at capacity returns ok: false, reason: ROOM_FULL', () => {
    const manager = new RoomManager({ maxRoomSize: 2 });
    const ws1 = { send: () => {} };
    const ws2 = { send: () => {} };
    const ws3 = { send: () => {} };

    manager.join('client1', 'room1', ws1);
    manager.join('client2', 'room1', ws2);
    
    expect(manager.join('client3', 'room1', ws3)).toEqual({ ok: false, reason: 'ROOM_FULL' });
  });

  test('server.js sends error frame when join is rejected', () => {
    // Reset roomManager to ensure clean state for this test if needed
    roomManager._maxRoomSize = 1;
    roomManager._rooms.clear();
    roomManager._clientRooms.clear();

    const ws1 = { send: () => {} };
    let sentMessage = null;
    const ws2 = { 
      send: (msg) => { sentMessage = msg; } 
    };

    handleJoin('client1', 'room2', ws1);
    const result = handleJoin('client2', 'room2', ws2);

    expect(result).toEqual({ ok: false, reason: 'ROOM_FULL' });
    expect(sentMessage).toBe(JSON.stringify({
      type: "error",
      payload: {
        message: "Room is full",
        code: "ROOM_FULL"
      }
    }));
  });

  test('disconnectClient removes a client from every room it joined', () => {
    const manager = new RoomManager({ maxRoomSize: 5 });
    const ws = { send: () => {} };

    manager.join('client1', 'roomA', ws);
    manager.join('client1', 'roomB', ws);
    manager.join('client1', 'roomC', ws);
    manager.join('client2', 'roomA', ws);

    manager.disconnectClient('client1');

    expect(manager._clientRooms.has('client1')).toBe(false);
    expect(manager._rooms.get('roomA').has('client1')).toBe(false);
    expect(manager._rooms.get('roomB')).toBeUndefined();
    expect(manager._rooms.get('roomC')).toBeUndefined();
    // client2 is untouched
    expect(manager._rooms.get('roomA').has('client2')).toBe(true);
  });

  test('disconnectClient on an unknown client is a no-op', () => {
    const manager = new RoomManager({ maxRoomSize: 5 });
    expect(() => manager.disconnectClient('ghost')).not.toThrow();
  });

  test('handleClose disconnects a client from all rooms via the shared roomManager', () => {
    roomManager._maxRoomSize = 5;
    roomManager._rooms.clear();
    roomManager._clientRooms.clear();

    const ws = { send: () => {} };
    handleJoin('client1', 'room1', ws);
    handleJoin('client1', 'room2', ws);

    handleClose('client1');

    expect(roomManager._clientRooms.has('client1')).toBe(false);
    expect(roomManager._rooms.has('room1')).toBe(false);
    expect(roomManager._rooms.has('room2')).toBe(false);
  });
});
