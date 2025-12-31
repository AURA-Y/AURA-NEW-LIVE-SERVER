import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  AccessToken,
  AgentDispatchClient,
  RoomServiceClient,
  RoomAgentDispatch,
} from 'livekit-server-sdk';
import { CreateRoomDto } from './dto/create-room.dto';
import { JoinRoomDto } from './dto/join-room.dto';

@Injectable()
export class LivekitService {
  private readonly logger = new Logger(LivekitService.name);
  private roomService: RoomServiceClient;
  private agentDispatch: AgentDispatchClient;
  private livekitUrl: string;
  private apiKey: string;
  private apiSecret: string;
  private agentName: string;

  constructor(private configService: ConfigService) {
    this.livekitUrl = this.configService.get<string>('LIVEKIT_URL');
    this.apiKey = this.configService.get<string>('LIVEKIT_API_KEY');
    this.apiSecret = this.configService.get<string>('LIVEKIT_API_SECRET');
    this.agentName = this.configService.get<string>('LIVEKIT_AGENT_NAME') || 'aura-bot';

    this.roomService = new RoomServiceClient(
      this.livekitUrl,
      this.apiKey,
      this.apiSecret,
    );
    this.agentDispatch = new AgentDispatchClient(
      this.livekitUrl,
      this.apiKey,
      this.apiSecret,
    );
  }

  private async ensureAgentDispatch(roomName: string) {
    if (!this.agentName) return;
    try {
      const dispatches = await this.agentDispatch.listDispatch(roomName);
      const exists = dispatches.some(
        (dispatch) => dispatch.agentName === this.agentName,
      );
      if (exists) return;
      await this.agentDispatch.createDispatch(roomName, this.agentName);
      this.logger.log(`Agent dispatch created: ${roomName} (${this.agentName})`);
    } catch (error) {
      this.logger.warn(`Failed to ensure agent dispatch: ${error.message}`);
    }
  }

  private buildRoomAgentDispatch() {
    if (!this.agentName) return [];
    return [
      new RoomAgentDispatch({
        agentName: this.agentName,
      }),
    ];
  }

  async createRoom(createRoomDto: CreateRoomDto) {
    const {
      userName,
      roomTitle = `Room-${Date.now()}`,
      description = '',
      maxParticipants = 20
    } = createRoomDto;

    try {
      // LiveKit에 방 생성
      const room = await this.roomService.createRoom({
        name: roomTitle,
        emptyTimeout: 300,
        maxParticipants: maxParticipants,
        agents: this.buildRoomAgentDispatch(),
      });

      await this.ensureAgentDispatch(room.name);

      // 생성자를 위한 토큰 자동 발급
      const token = await this.generateTokenForUser(room.name, userName);
      const wsUrl = this.livekitUrl.replace('http://', 'ws://').replace('https://', 'wss://');

      return {
        roomId: room.sid,
        roomUrl: `${wsUrl}/${room.name}`,
        roomTitle: room.name,
        description: description,
        maxParticipants: room.maxParticipants,
        userName: userName,
        token: token,
        livekitUrl: wsUrl,
      };
    } catch (error) {
      throw new Error(`Failed to create room: ${error.message}`);
    }
  }

  async joinRoom(joinRoomDto: JoinRoomDto) {
    const { roomId, userName } = joinRoomDto;

    try {
      // 모든 방을 조회한 후 sid로 필터링
      const allRooms = await this.roomService.listRooms();
      const room = allRooms.find((r) => r.sid === roomId || r.name === roomId);

      if (!room) {
        throw new Error('Room not found');
      }
      await this.ensureAgentDispatch(room.name);
      const token = await this.generateTokenForUser(room.name, userName);
      const wsUrl = this.livekitUrl.replace('http://', 'ws://').replace('https://', 'wss://');

      return {
        token: token,
        url: wsUrl,
      };
    } catch (error) {
      throw new Error(`Failed to join room: ${error.message}`);
    }
  }

  async listRooms() {
    try {
      const rooms = await this.roomService.listRooms();

      const formattedRooms = rooms.map(room => ({
        roomId: room.sid,
        roomTitle: room.name,
        description: '',
        maxParticipants: room.maxParticipants,
        createdBy: '',
        createdAt: new Date(Number(room.creationTime) * 1000).toISOString(),
      }));

      return {
        rooms: formattedRooms,
        total: formattedRooms.length,
      };
    } catch (error) {
      throw new Error(`Failed to list rooms: ${error.message}`);
    }
  }

  async getRoom(roomId: string) {
    try {
      // 모든 방을 조회한 후 sid로 필터링
      const allRooms = await this.roomService.listRooms();
      const room = allRooms.find(r => r.sid === roomId);

      if (!room) {
        throw new Error('Room not found');
      }

      return {
        roomId: room.sid,
        roomTitle: room.name,
        description: '',
        maxParticipants: room.maxParticipants,
        createdBy: '',
        createdAt: new Date(Number(room.creationTime) * 1000).toISOString(),
      };
    } catch (error) {
      throw new Error(`Failed to get room: ${error.message}`);
    }
  }

  private async generateTokenForUser(roomName: string, userName: string): Promise<string> {
    const at = new AccessToken(this.apiKey, this.apiSecret, {
      identity: userName,
      ttl: '24h',
    });

    at.addGrant({
      room: roomName,
      roomJoin: true,
      canPublish: true,
      canSubscribe: true,
      canPublishData: true,
    });

    return await at.toJwt();
  }
}
