import { Injectable, Logger, Inject, forwardRef } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  AccessToken,
  AgentDispatchClient,
  RoomServiceClient,
  RoomAgentDispatch,
} from 'livekit-server-sdk';
import { CreateRoomDto } from './dto/create-room.dto';
import { JoinRoomDto } from './dto/join-room.dto';
import { VoiceBotService } from './voice-bot.service';

@Injectable()
export class LivekitService {
  private readonly logger = new Logger(LivekitService.name);
  private roomService: RoomServiceClient;
  private agentDispatch: AgentDispatchClient;
  private livekitUrl: string;
  private apiKey: string;
  private apiSecret: string;
  private agentName: string;

  constructor(
    private configService: ConfigService,
    @Inject(forwardRef(() => VoiceBotService))
    private voiceBotService: VoiceBotService,
  ) {
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

      // 방 생성 시 AI 봇 자동 시작
      this.logger.log(`[자동 봇 시작] 방 생성으로 AI 봇 자동 시작: ${room.name}`);
      this.startBotForRoom(room.name).catch(err => {
        this.logger.error(`[자동 봇 시작 실패] ${err.message}`);
      });

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

  async joinRoom(joinRoomDto: JoinRoomDto, isBot: boolean = false) {
    const { roomId, roomName, userName } = joinRoomDto;
    this.logger.log(`Join request: roomId=${roomId}, roomName=${roomName}, user=${userName}`);

    try {
      let finalRoomName = roomName;

      // roomId(SID)가 제공된 경우
      if (roomId) {
        const allRooms = await this.roomService.listRooms();
        // 1. SID로 먼저 찾아봄
        let room = allRooms.find(r => r.sid === roomId);

        // 2. 못 찾았다면 이름으로도 찾아봄 (프론트에서 이름을 ID로 보낼 수 있음)
        if (!room) {
          room = allRooms.find(r => r.name === roomId);
        }

        if (!room) {
          // 그래도 없는데 roomName도 없다면 에러
          if (!finalRoomName) {
            this.logger.error(`Room not found for ID: ${roomId}`);
            throw new Error('Room not found');
          }
        } else {
          finalRoomName = room.name;
        }
      }


      if (!finalRoomName) {
        throw new Error('Either roomId or roomName must be provided');
      }


      await this.ensureAgentDispatch(finalRoomName);
      this.logger.log(`Generating ${isBot ? 'BOT ' : ''}token for room: ${finalRoomName}`);
      const token = await this.generateTokenForUser(finalRoomName, userName, isBot);
      const wsUrl = this.livekitUrl.replace('http://', 'ws://').replace('https://', 'wss://');

      // 사용자 입장 시 봇이 없으면 자동 시작 (봇 자신의 입장 제외)
      if (!isBot && !this.voiceBotService.isActive(finalRoomName)) {
        this.logger.log(`[봇 재시작] 방에 봇이 없어서 자동 시작: ${finalRoomName}`);
        this.startBotForRoom(finalRoomName).catch(err => {
          this.logger.error(`[봇 재시작 실패] ${err.message}`);
        });
      }

      return {
        token: token,
        url: wsUrl,
      };
    } catch (error) {
      this.logger.error(`Join failed: ${error.message}`);
      throw new Error(`Failed to join room: ${error.message}`);
    }
  }

  /**
   * 방에 AI 봇 자동 시작
   */
  private async startBotForRoom(roomName: string): Promise<void> {
    try {
      // 봇용 토큰 생성
      const botName = `ai-bot-${Math.floor(Math.random() * 1000)}`;
      const botToken = await this.generateTokenForUser(roomName, botName, true);

      // 봇 시작
      await this.voiceBotService.startBot(roomName, botToken);
      this.logger.log(`[자동 봇 시작 완료] ${roomName}`);
    } catch (error) {
      this.logger.error(`[자동 봇 시작 실패] ${error.message}`);
      throw error;
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

  private async generateTokenForUser(roomName: string, userName: string, isBot: boolean = false): Promise<string> {
    const at = new AccessToken(this.apiKey, this.apiSecret, {
      identity: userName,
      ttl: '24h',
    });

    if (isBot) {
      // 봇: 발행 가능, 참여자로 표시
      at.addGrant({
        room: roomName,
        roomJoin: true,
        canPublish: true,
        canSubscribe: true,
        canPublishData: true,
        hidden: false,
      });
    } else {
      at.addGrant({
        room: roomName,
        roomJoin: true,
        canPublish: true,
        canSubscribe: true,
        canPublishData: true,
      });
    }

    return await at.toJwt();
  }
}
