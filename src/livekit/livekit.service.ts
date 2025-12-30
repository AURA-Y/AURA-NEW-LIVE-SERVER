import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AccessToken, RoomServiceClient } from 'livekit-server-sdk';
import { CreateRoomDto } from './dto/create-room.dto';
import { JoinRoomDto } from './dto/join-room.dto';

@Injectable()
export class LivekitService {
  private roomService: RoomServiceClient;
  private livekitUrl: string;
  private apiKey: string;
  private apiSecret: string;

  constructor(private configService: ConfigService) {
    this.livekitUrl = this.configService.get<string>('LIVEKIT_URL');
    this.apiKey = this.configService.get<string>('LIVEKIT_API_KEY');
    this.apiSecret = this.configService.get<string>('LIVEKIT_API_SECRET');

    this.roomService = new RoomServiceClient(
      this.livekitUrl,
      this.apiKey,
      this.apiSecret,
    );
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
      });

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
      // roomId(sid)로 방 정보 조회
      const rooms = await this.roomService.listRooms([roomId]);

      if (!rooms || rooms.length === 0) {
        throw new Error('Room not found');
      }

      const room = rooms[0];
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
      const rooms = await this.roomService.listRooms([roomId]);

      if (!rooms || rooms.length === 0) {
        throw new Error('Room not found');
      }

      const room = rooms[0];

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
