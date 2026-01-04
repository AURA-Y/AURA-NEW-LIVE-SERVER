declare module 'livekit-server-sdk' {
  export class AccessToken {
    constructor(
      apiKey: string,
      apiSecret: string,
      options?: {
        identity?: string;
        ttl?: string | number;
      },
    );
    addGrant(grant: Record<string, unknown>): void;
    toJwt(): Promise<string>;
  }

  export class RoomServiceClient {
    constructor(url: string, apiKey: string, apiSecret: string);
    createRoom(options: Record<string, unknown>): Promise<any>;
    listRooms(): Promise<any[]>;
    deleteRoom(room: string): Promise<void>;
  }

  export class AgentDispatchClient {
    constructor(url: string, apiKey: string, apiSecret: string);
    listDispatch(roomName: string): Promise<any[]>;
    createDispatch(roomName: string, agentName: string): Promise<any>;
  }

  export class RoomAgentDispatch {
    constructor(options: { agentName: string });
  }
}
