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
    const { roomName } = createRoomDto;

    try {
      const room = await this.roomService.createRoom({
        name: roomName,
        emptyTimeout: 300, // 5분 동안 비어있으면 자동 삭제
        maxParticipants: 20,
      });

      return {
        success: true,
        room: {
          name: room.name,
          sid: room.sid,
        },
      };
    } catch (error) {
      return {
        success: false,
        error: error.message,
      };
    }
  }

  async generateToken(joinRoomDto: JoinRoomDto) {
    const { roomName, participantName } = joinRoomDto;

    // JWT 토큰 생성 (유효기간 24시간)
    const at = new AccessToken(this.apiKey, this.apiSecret, {
      identity: participantName,
      ttl: '24h', // 토큰 유효기간
    });

    // Room 권한 설정
    at.addGrant({
      room: roomName,
      roomJoin: true,
      canPublish: true,
      canSubscribe: true,
      canPublishData: true,
    });

    // JWT 토큰 생성
    const token = await at.toJwt();

    console.log(`Generated JWT token for ${participantName} in room ${roomName}`);
    console.log(`Using API Key: ${this.apiKey}`);

    // HTTP URL을 WebSocket URL로 변환 (클라이언트용)
    const wsUrl = this.livekitUrl.replace('http://', 'ws://').replace('https://', 'wss://');

    return {
      token,
      url: wsUrl,
    };
  }

  async listRooms() {
    try {
      const rooms = await this.roomService.listRooms();
      return {
        success: true,
        rooms,
      };
    } catch (error) {
      return {
        success: false,
        error: error.message,
      };
    }
  }
}
