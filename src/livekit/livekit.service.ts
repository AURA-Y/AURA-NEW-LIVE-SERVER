import { Injectable, Logger, Inject, forwardRef } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import {
  AccessToken,
  AgentDispatchClient,
  RoomServiceClient,
  RoomAgentDispatch,
} from "livekit-server-sdk";
import { CreateRoomDto } from "./dto/create-room.dto";
import { JoinRoomDto } from "./dto/join-room.dto";
import { VoiceBotService } from "./voice-bot.service";

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
    private voiceBotService: VoiceBotService
  ) {
    this.livekitUrl = this.configService.get<string>("LIVEKIT_URL");
    this.apiKey = this.configService.get<string>("LIVEKIT_API_KEY");
    this.apiSecret = this.configService.get<string>("LIVEKIT_API_SECRET");
    this.agentName =
      this.configService.get<string>("LIVEKIT_AGENT_NAME") || "aura-bot";

    this.roomService = new RoomServiceClient(
      this.livekitUrl,
      this.apiKey,
      this.apiSecret
    );
    this.agentDispatch = new AgentDispatchClient(
      this.livekitUrl,
      this.apiKey,
      this.apiSecret
    );
  }

  private async ensureAgentDispatch(roomName: string) {
    if (!this.agentName) return;
    try {
      const dispatches = await this.agentDispatch.listDispatch(roomName);
      const exists = dispatches.some(
        (dispatch) => dispatch.agentName === this.agentName
      );
      if (exists) return;
      await this.agentDispatch.createDispatch(roomName, this.agentName);
      this.logger.log(
        `Agent dispatch created: ${roomName} (${this.agentName})`
      );
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
      description = "",
      maxParticipants = 20,
    } = createRoomDto;

    try {
      this.logger.log(`Creating room via LiveKit: ${this.livekitUrl}`);
      // LiveKit 방 이름은 고유 ID로 생성 (한글/특수문자 문제 방지 및 고유성 보장)
      const uniqueRoomName = crypto.randomUUID();

      // LiveKit에 방 생성
      const room = await this.roomService.createRoom({
        name: uniqueRoomName,
        emptyTimeout: 300,
        maxParticipants: maxParticipants,
        agents: this.buildRoomAgentDispatch(),
        metadata: JSON.stringify({ title: roomTitle }), // 메타데이터에 제목 저장
      });

      await this.ensureAgentDispatch(room.name);

      // 생성자를 위한 토큰 자동 발급
      const token = await this.generateTokenForUser(room.name, userName);
      const wsUrl = this.livekitUrl
        .replace("http://", "ws://")
        .replace("https://", "wss://");

      // 방 생성 시 AI 봇은 사용자가 입장할 때 자동 시작됨 (joinRoom에서 처리)

      return {
        roomId: room.sid,
        roomUrl: `${wsUrl}/${room.name}`,
        roomTitle: roomTitle, // DB Topic (사용자에게 보여질 이름)
        livekitRoomName: room.name, // 실제 LiveKit 방 이름 (UUID)
        description: description,
        maxParticipants: room.maxParticipants,
        userName: userName,
        token: token,
        livekitUrl: wsUrl,
      };
    } catch (error) {
      this.logger.error(`Create room failed: ${error.message}`);
      if (error.cause) {
        this.logger.error(`Create room cause: ${error.cause}`);
      }
      throw new Error(`Failed to create room: ${error.message}`);
    }
  }

  async joinRoom(joinRoomDto: JoinRoomDto, isBot: boolean = false) {
    const { roomId, roomName, userName } = joinRoomDto;
    this.logger.log(
      `Join request: roomId=${roomId}, roomName=${roomName}, user=${userName}`
    );

    try {
      let finalRoomName = roomName;

      // roomId 또는 roomName을 사용하여 방 찾기
      const queryId = roomId || roomName;

      if (queryId) {
        const allRooms = await this.roomService.listRooms();
        let room = allRooms.find((r) => r.sid === queryId);

        // 2. 못 찾았다면 이름으로도 찾아봄 (프론트에서 이름을 ID로 보낼 수 있음)
        if (!room) {
          room = allRooms.find((r) => r.name === queryId);
        }

        // 3. 그래도 못 찾았다면 메타데이터(Title)로 찾아봄
        if (!room) {
          this.logger.log(
            `Room not found by ID/Name '${queryId}', searching metadata...`
          );
          room = allRooms.find((r) => {
            try {
              const meta = JSON.parse(r.metadata || "{}");
              if (!meta || !meta.title) return false;

              const targetTitle = meta.title.trim();
              const q = queryId.trim();
              const qDecoded = decodeURIComponent(queryId).trim();

              return targetTitle === q || targetTitle === qDecoded;
            } catch (e) {
              return false;
            }
          });
        }

        if (room) {
          finalRoomName = room.name; // UUID로 설정
        } else {
          // 방을 못 찾았지만, roomId가 명시적으로 있었다면 에러
          // roomName만 있었다면, 새로운 방 이름으로 사용될 수 있음 (하지만 Bot이 들어가려면 기존 방이어야 함)
          if (roomId) {
            this.logger.error(`Room not found for ID: ${roomId}`);
            throw new Error("Room not found");
          }
        }
      }

      if (!finalRoomName) {
        throw new Error("Either roomId or roomName must be provided");
      }
      this.logger.log(`Joining room via LiveKit: ${this.livekitUrl}`);
      await this.ensureAgentDispatch(finalRoomName);
      this.logger.log(
        `Generating ${isBot ? "BOT " : ""}token for room: ${finalRoomName}`
      );
      const token = await this.generateTokenForUser(
        finalRoomName,
        userName,
        isBot
      );
      const wsUrl = this.livekitUrl
        .replace("http://", "ws://")
        .replace("https://", "wss://");

      // 봇은 방 생성 시에만 시작 (join 시에는 봇 시작하지 않음) -> 정책 변경: 방에 봇이 없으면 시작
      if (!isBot && !(await this.hasBotParticipant(finalRoomName))) {
        // isActive check replacement
        this.logger.log(
          `[봇 재시작] 방에 봇이 없어서 자동 시작: ${finalRoomName}`
        );

        // 룸 메타데이터에서 Topic 가져오기
        let roomTitleForBot = finalRoomName;
        try {
          const roomObj = (await this.roomService.listRooms()).find(
            (r) => r.name === finalRoomName
          );
          if (roomObj && roomObj.metadata) {
            const meta = JSON.parse(roomObj.metadata);
            if (meta.title) roomTitleForBot = meta.title;
          }
        } catch (e) {}

        this.startBotForRoom(finalRoomName, roomTitleForBot).catch((err) => {
          this.logger.error(`[봇 재시작 실패] ${err.message}`);
        });
      }

      return {
        token: token,
        url: wsUrl,
      };
    } catch (error) {
      this.logger.error(`Join failed: ${error.message}`);
      if (error.cause) {
        this.logger.error(`Join cause: ${error.cause}`);
      }
      throw new Error(`Failed to join room: ${error.message}`);
    }
  }

  /**
   * 방에 AI 봇 자동 시작
   */
  private async startBotForRoom(
    roomName: string,
    roomTitle?: string
  ): Promise<void> {
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

      const formattedRooms = rooms.map((room) => ({
        roomId: room.sid,
        roomTitle: room.name,
        description: "",
        maxParticipants: room.maxParticipants,
        createdBy: "",
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

  async hasBotParticipant(roomName: string): Promise<boolean> {
    try {
      const participants = await (
        this.roomService as unknown as {
          listParticipants: (room: string) => Promise<{ identity: string }[]>;
        }
      ).listParticipants(roomName);
      return participants.some((participant) =>
        participant.identity.startsWith("ai-bot")
      );
    } catch (error) {
      this.logger.warn(
        `Failed to list participants for ${roomName}: ${error.message}`
      );
      return false;
    }
  }

  async listBotIdentities(roomName: string): Promise<string[]> {
    try {
      const participants = await (
        this.roomService as unknown as {
          listParticipants: (room: string) => Promise<{ identity: string }[]>;
        }
      ).listParticipants(roomName);
      return participants
        .map((participant) => participant.identity)
        .filter((identity) => identity.startsWith("ai-bot"));
    } catch (error) {
      this.logger.warn(
        `Failed to list participants for ${roomName}: ${error.message}`
      );
      return [];
    }
  }

  async removeBots(roomName: string): Promise<void> {
    const botIdentities = await this.listBotIdentities(roomName);
    if (botIdentities.length === 0) return;

    for (const identity of botIdentities) {
      try {
        await (
          this.roomService as unknown as {
            removeParticipant: (
              room: string,
              identity: string
            ) => Promise<void>;
          }
        ).removeParticipant(roomName, identity);
        this.logger.log(`Removed bot participant: ${roomName} (${identity})`);
      } catch (error) {
        this.logger.warn(
          `Failed to remove bot ${identity} from ${roomName}: ${error.message}`
        );
      }
    }
  }

  async getRoom(roomId: string) {
    try {
      // 모든 방을 조회한 후 sid로 필터링
      const allRooms = await this.roomService.listRooms();
      const room = allRooms.find((r) => r.sid === roomId);

      if (!room) {
        throw new Error("Room not found");
      }

      return {
        roomId: room.sid,
        roomTitle: room.name,
        description: "",
        maxParticipants: room.maxParticipants,
        createdBy: "",
        createdAt: new Date(Number(room.creationTime) * 1000).toISOString(),
      };
    } catch (error) {
      throw new Error(`Failed to get room: ${error.message}`);
    }
  }

  async deleteRoom(roomId: string) {
    try {
      this.logger.log(`Deleting room: ${roomId}`);

      // roomId가 실제로는 room name일 수 있으므로 확인
      const allRooms = await this.roomService.listRooms();
      let roomToDelete = allRooms.find((r) => r.sid === roomId);

      // SID로 못 찾으면 이름으로 찾기
      if (!roomToDelete) {
        roomToDelete = allRooms.find((r) => r.name === roomId);
      }

      if (!roomToDelete) {
        throw new Error("Room not found");
      }

      // LiveKit 서버에서 방 삭제 (모든 참가자 자동 disconnect)
      await this.roomService.deleteRoom(roomToDelete.name);

      this.logger.log(`Room deleted successfully: ${roomToDelete.name}`);

      return {
        message: "Room deleted successfully",
        roomId: roomToDelete.sid,
        roomName: roomToDelete.name,
      };
    } catch (error) {
      this.logger.error(`Failed to delete room: ${error.message}`);
      throw new Error(`Failed to delete room: ${error.message}`);
    }
  }

  private async generateTokenForUser(
    roomName: string,
    userName: string,
    isBot: boolean = false
  ): Promise<string> {
    const at = new AccessToken(this.apiKey, this.apiSecret, {
      identity: userName,
      ttl: "24h",
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
