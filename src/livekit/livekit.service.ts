import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AccessToken, RoomServiceClient } from 'livekit-server-sdk';
import { CreateRoomDto } from './dto/create-room.dto';
import { JoinRoomDto } from './dto/join-room.dto';

@Injectable()
export class LivekitService {
  private roomService: RoomServiceClient;
  private livekitUrl: string;
  private livekitPublicUrl: string;
  private apiKey: string;
  private apiSecret: string;

  constructor(private configService: ConfigService) {
    this.livekitUrl = this.configService.get<string>('LIVEKIT_URL');
    this.livekitPublicUrl =
      this.configService.get<string>('LIVEKIT_PUBLIC_URL') || this.livekitUrl;
    this.apiKey = this.configService.get<string>('LIVEKIT_API_KEY');
    this.apiSecret = this.configService.get<string>('LIVEKIT_API_SECRET');

    this.roomService = new RoomServiceClient(
      this.livekitUrl,
      this.apiKey,
      this.apiSecret,
    );
  }

  // LiveKit identity 충돌 방지를 위해 랜덤 suffix를 붙여 고유 identity 생성
  private makeUniqueIdentity(userName: string): string {
    const suffix = Math.random().toString(36).substring(2, 7);
    return `${userName}-${suffix}`;
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
      const identity = this.makeUniqueIdentity(userName);
      const token = await this.generateTokenForUser(room.name, identity);
      const wsUrl = this.toWsUrl(this.livekitPublicUrl);

      return {
        roomId: room.sid,
        roomUrl: `${wsUrl}/${room.name}`,
        roomTitle: room.name,
        description: description,
        maxParticipants: room.maxParticipants,
        userName: identity,
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
      const room = allRooms.find(r => r.sid === roomId);

      if (!room) {
        throw new Error('Room not found');
      }
      const identity = this.makeUniqueIdentity(userName);
      const token = await this.generateTokenForUser(room.name, identity);
      const wsUrl = this.toWsUrl(this.livekitPublicUrl);

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

  private toWsUrl(url: string) {
    if (url.startsWith('ws://') || url.startsWith('wss://')) return url;
    if (url.startsWith('https://')) return url.replace('https://', 'wss://');
    if (url.startsWith('http://')) return url.replace('http://', 'ws://');
    return url;
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
