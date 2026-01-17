import {
  BadRequestException,
  Inject,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
  forwardRef,
} from '@nestjs/common';
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
import { RAG_CLIENT, IRagClient } from '../rag/rag-client.interface';

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
    @Inject(RAG_CLIENT)
    private ragClient: IRagClient,
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

  private async ensureAgentDispatch(roomId: string) {
    if (!this.agentName) return;
    try {
      const dispatches = await this.agentDispatch.listDispatch(roomId);
      const exists = dispatches.some(
        (dispatch) => dispatch.agentName === this.agentName,
      );
      if (exists) return;
      await this.agentDispatch.createDispatch(roomId, this.agentName);
      this.logger.log(`Agent dispatch created: ${roomId} (${this.agentName})`);
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

  /**
   * 고유한 방 ID 생성
   */
  private generateRoomId(): string {
    const timestamp = Date.now();
    const random = Math.random().toString(36).slice(2, 8);
    return `room-${timestamp}-${random}`;
  }

  /**
   * 방 메타데이터 파싱
   */
  private parseRoomMetadata(metadata: string | undefined): {
    topic: string;
    description: string;
    createdBy: string;
  } {
    if (!metadata) {
      return { topic: '', description: '', createdBy: '' };
    }
    try {
      const parsed = JSON.parse(metadata);
      // title → topic 마이그레이션 지원
      return {
        topic: parsed.topic || parsed.title || '',
        description: parsed.description || '',
        createdBy: parsed.createdBy || '',
      };
    } catch {
      return { topic: '', description: '', createdBy: '' };
    }
  }

  async createRoom(createRoomDto: CreateRoomDto) {
    const {
      userName,
      roomTopic,
      description = '',
      maxParticipants = 20
    } = createRoomDto;

    const startTime = Date.now();
    const log = (msg: string) => this.logger.log(`[createRoom +${Date.now() - startTime}ms] ${msg}`);

    try {
      log(`시작 - user: ${userName}, topic: ${roomTopic}`);
      log(`LiveKit URL: ${this.livekitUrl}`);

      // 고유한 방 ID 생성
      const roomId = this.generateRoomId();
      log(`방 ID 생성: ${roomId}`);

      // 메타데이터에 표시용 정보 저장
      const metadata = JSON.stringify({
        topic: roomTopic,
        description: description,
        createdBy: userName,
      });
      log(`메타데이터 준비 완료`);

      // LiveKit에 방 생성
      log(`>>> LiveKit roomService.createRoom() 호출 시작...`);
      const room = await this.roomService.createRoom({
        name: roomId,
        metadata: metadata,
        emptyTimeout: 300,
        maxParticipants: maxParticipants,
        agents: this.buildRoomAgentDispatch(),
      });
      log(`<<< LiveKit roomService.createRoom() 완료`);

      // Agent Dispatch는 비동기로 처리 (응답 지연 방지)
      log(`Agent dispatch 비동기 시작`);
      void this.ensureAgentDispatch(room.name).catch((err) => {
        this.logger.warn(`[createRoom] Agent dispatch 실패 (무시): ${err.message}`);
      });

      // 생성자를 위한 토큰 자동 발급
      log(`>>> 토큰 생성 시작...`);
      const token = await this.generateTokenForUser(room.name, userName);
      log(`<<< 토큰 생성 완료`);

      const wsUrl = this.livekitUrl.replace('http://', 'ws://').replace('https://', 'wss://');

      log(`✅ 완료 - roomId: ${room.name}`);

      return {
        roomId: room.name,
        roomUrl: `${wsUrl}/${room.name}`,
        roomTopic: roomTopic,
        description: description,
        maxParticipants: room.maxParticipants,
        userName: userName,
        token: token,
        livekitUrl: wsUrl,
      };
    } catch (error) {
      log(`❌ 에러: ${error.message}`);
      if (error.cause) {
        log(`❌ 원인: ${error.cause}`);
      }
      throw new Error(`Failed to create room: ${error.message}`);
    }
  }

  async joinRoom(joinRoomDto: JoinRoomDto, isBot: boolean = false) {
    const { roomId, userName } = joinRoomDto;
    this.logger.log(`Join request: roomId=${roomId}, user=${userName}`);

    try {
      if (!roomId) {
        throw new BadRequestException('roomId is required');
      }

      // 방 존재 여부 확인
      const allRooms = await this.roomService.listRooms();
      const room = allRooms.find(r => r.name === roomId);
      if (!room) {
        this.logger.error(`Room not found: ${roomId}`);
        throw new NotFoundException('Room not found');
      }

      this.logger.log(`Joining room via LiveKit: ${this.livekitUrl}`);
      await this.ensureAgentDispatch(roomId);
      this.logger.log(`Generating ${isBot ? 'BOT ' : ''}token for room: ${roomId}`);
      const token = await this.generateTokenForUser(roomId, userName, isBot);
      const wsUrl = this.livekitUrl.replace('http://', 'ws://').replace('https://', 'wss://');

      return {
        token: token,
        url: wsUrl,
      };
    } catch (error) {
      this.logger.error(`Join failed: ${error.message}`);
      if (error.cause) {
        this.logger.error(`Join cause: ${error.cause}`);
      }
      if (error instanceof BadRequestException || error instanceof NotFoundException) {
        throw error;
      }
      throw new InternalServerErrorException(`Failed to join room: ${error.message}`);
    }
  }

  async listRooms() {
    try {
      const rooms = await this.roomService.listRooms();

      const formattedRooms = rooms.map(room => {
        const meta = this.parseRoomMetadata(room.metadata);
        return {
          roomId: room.name,
          roomTopic: meta.topic || room.name,
          description: meta.description,
          maxParticipants: room.maxParticipants,
          createdBy: meta.createdBy,
          createdAt: new Date(Number(room.creationTime) * 1000).toISOString(),
        };
      });

      return {
        rooms: formattedRooms,
        total: formattedRooms.length,
      };
    } catch (error) {
      throw new Error(`Failed to list rooms: ${error.message}`);
    }
  }

  async hasBotParticipant(roomId: string): Promise<boolean> {
    try {
      const participants = await (this.roomService as unknown as {
        listParticipants: (room: string) => Promise<{ identity: string }[]>;
      }).listParticipants(roomId);
      return participants.some((participant) => participant.identity.startsWith('ai-bot'));
    } catch (error) {
      this.logger.warn(`Failed to list participants for ${roomId}: ${error.message}`);
      return false;
    }
  }

  async listBotIdentities(roomId: string): Promise<string[]> {
    try {
      const participants = await (this.roomService as unknown as {
        listParticipants: (room: string) => Promise<{ identity: string }[]>;
      }).listParticipants(roomId);
      return participants
        .map((participant) => participant.identity)
        .filter((identity) => identity.startsWith('ai-bot'));
    } catch (error) {
      this.logger.warn(`Failed to list participants for ${roomId}: ${error.message}`);
      return [];
    }
  }

  async removeBots(roomId: string): Promise<void> {
    const botIdentities = await this.listBotIdentities(roomId);
    if (botIdentities.length === 0) return;

    for (const identity of botIdentities) {
      try {
        await (this.roomService as unknown as {
          removeParticipant: (room: string, identity: string) => Promise<void>;
        }).removeParticipant(roomId, identity);
        this.logger.log(`Removed bot participant: ${roomId} (${identity})`);
      } catch (error) {
        this.logger.warn(`Failed to remove bot ${identity} from ${roomId}: ${error.message}`);
      }
    }
  }

  async getRoom(roomId: string) {
    try {
      const allRooms = await this.roomService.listRooms();
      const room = allRooms.find(r => r.name === roomId);

      if (!room) {
        throw new Error('Room not found');
      }

      const meta = this.parseRoomMetadata(room.metadata);

      return {
        roomId: room.name,
        roomTopic: meta.topic || room.name,
        description: meta.description,
        maxParticipants: room.maxParticipants,
        createdBy: meta.createdBy,
        createdAt: new Date(Number(room.creationTime) * 1000).toISOString(),
      };
    } catch (error) {
      throw new Error(`Failed to get room: ${error.message}`);
    }
  }

  async deleteRoom(roomId: string) {
    try {
      this.logger.log(`Deleting room: ${roomId}`);

      const allRooms = await this.roomService.listRooms();
      const roomToDelete = allRooms.find(r => r.name === roomId);

      if (!roomToDelete) {
        throw new Error('Room not found');
      }

      // LiveKit 서버에서 방 삭제 (모든 참가자 자동 disconnect)
      await this.roomService.deleteRoom(roomToDelete.name);

      this.logger.log(`Room deleted successfully: ${roomToDelete.name}`);

      return {
        message: 'Room deleted successfully',
        roomId: roomToDelete.name,
      };
    } catch (error) {
      this.logger.error(`Failed to delete room: ${error.message}`);
      throw new Error(`Failed to delete room: ${error.message}`);
    }
  }

  private async generateTokenForUser(roomId: string, userName: string, isBot: boolean = false): Promise<string> {
    const at = new AccessToken(this.apiKey, this.apiSecret, {
      identity: userName,
      ttl: '24h',
    });

    if (isBot) {
      // 봇: 발행 가능, 참여자로 표시
      at.addGrant({
        room: roomId,
        roomJoin: true,
        canPublish: true,
        canSubscribe: true,
        canPublishData: true,
        hidden: false,
      });
    } else {
      at.addGrant({
        room: roomId,
        roomJoin: true,
        canPublish: true,
        canSubscribe: true,
        canPublishData: true,
      });
    }

    return await at.toJwt();
  }

  /**
   * 방에 AI 봇 시작
   */
  async startBotForRoom(roomId: string): Promise<void> {
    try {
      // 기존 봇 정리
      if (this.voiceBotService.isActive(roomId)) {
        await this.voiceBotService.stopBot(roomId);
      }
      await this.removeBots(roomId);

      // 봇용 토큰 생성
      const botName = `ai-bot-${Math.floor(Math.random() * 1000)}`;
      const botToken = await this.generateTokenForUser(roomId, botName, true);

      // 봇 시작
      await this.voiceBotService.startBot(roomId, botToken);
      this.logger.log(`[봇 시작 완료] ${roomId}`);
    } catch (error) {
      this.logger.error(`[봇 시작 실패] ${error.message}`);
      throw error;
    }
  }

  /**
   * 방에서 AI 봇 종료
   */
  async stopBotForRoom(roomId: string): Promise<void> {
    await this.voiceBotService.stopBot(roomId);
    this.logger.log(`[봇 종료 완료] ${roomId}`);
  }

  /**
   * 방의 AI 봇 활성 상태 확인
   */
  isBotActive(roomId: string): boolean {
    return this.voiceBotService.isActive(roomId);
  }

  /**
   * 파일 임베딩 요청 (RAG)
   */
  async embedFiles(
    roomId: string,
    files: { bucket: string; key: string }[],
    topic: string,
    description?: string,
  ): Promise<{ success: boolean; message?: string }> {
    this.logger.log(`[파일 임베딩] roomId: ${roomId}, topic: ${topic}, files: ${files.length}개`);

    const result = await this.ragClient.startMeeting(roomId, {
      roomTopic: topic,
      description: description || '',
      files,
    });

    return result;
  }

  /**
   * 회의 종료 (봇 대기 모드 + RAG 요약 요청)
   * 봇은 대기 모드로 전환되어 STT/응답 비활성화, 인간 참여자 없을 때 30초 후 자동 퇴장
   */
  async endMeeting(roomId: string): Promise<{ success: boolean; message?: string }> {
    this.logger.log(`[회의 종료] roomId: ${roomId}`);

    // 1. 봇을 대기 모드로 전환 (STT/응답 비활성화, 리소스 절약)
    if (this.isBotActive(roomId)) {
      await this.voiceBotService.enterStandbyMode(roomId);
      this.logger.log(`[회의 종료] 봇 대기 모드 전환 완료`);
    }

    // 2. RAG 서버에 회의 종료 알림 (요약 생성 트리거)
    const result = await this.ragClient.endMeeting(roomId);
    this.logger.log(`[회의 종료] RAG 응답: ${result.message}`);

    return result;
  }

  /**
   * 중간 보고서 요청
   */
  async requestReport(roomId: string): Promise<{ success: boolean; message?: string; report?: any }> {
    this.logger.log(`[중간 보고서 요청] roomId: ${roomId}`);

    const result = await this.ragClient.requestReport(roomId);
    this.logger.log(`[중간 보고서] RAG 응답: ${result.message}`);

    return result;
  }
}
