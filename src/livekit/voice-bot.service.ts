import { Injectable, Logger, Inject } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
    Room,
    RoomEvent,
    RemoteTrack,
    RemoteTrackPublication,
    RemoteParticipant,
    AudioStream,
    TrackKind,
    LocalAudioTrack,
    AudioSource,
    AudioFrame,
    TrackPublishOptions,
    TrackSource,
} from '@livekit/rtc-node';
import { SttService } from '../stt/stt.service';
import { LlmService } from '../llm/llm.service';
import { TtsService } from '../tts/tts.service';
import { RAG_CLIENT, IRagClient } from '../rag/rag-client.interface';
import { IntentClassifierService } from '../intent/intent-classifier.service';
import { VisionService, VisionContext } from '../vision/vision.service';

enum BotState {
    SLEEP = 'SLEEP',
    ARMED = 'ARMED',
    SPEAKING = 'SPEAKING'
}



// 대화 히스토리 타입
interface ConversationTurn {
    role: 'user' | 'assistant';
    content: string;
    timestamp: number;
}

interface RoomContext {
    room: Room;
    audioSource: AudioSource;
    localAudioTrack: LocalAudioTrack;
    isPublishing: boolean;
    shouldInterrupt: boolean;
    currentRequestId: number;
    botState: BotState;
    lastInteractionTime: number;
    lastSttTimeByUser: Map<string, number>;  // 사용자별 STT 쿨다운
    lastResponseTime: number;
    lastSpeechTime: number;
    speakingStartTime: number;
    activeUserId: string | null;
    // Vision (화면 공유 분석) 관련
    hasActiveScreenShare: boolean;           // 화면 공유 활성 여부
    isVisionMode: boolean;                   // Vision 모드 활성 여부
    pendingVisionRequest?: {                 // 대기 중인 Vision 요청
        requestId: number;
        userQuestion: string;
        userId: string;
    };
    // 아이디어 모드
    ideaModeActive: boolean;
    lastIdeaModeChange: number;
    shutdownTimeout?: NodeJS.Timeout;
    // ★ 대화 메모리 및 팔로업 윈도우
    conversationHistory: ConversationTurn[];  // 최근 대화 히스토리
    isInFollowUpWindow: boolean;              // 팔로업 윈도우 활성 여부
    followUpExpiresAt: number;                // 팔로업 윈도우 만료 시간
    lastBotQuestion: string | null;           // 마지막 봇 질문 (컨텍스트용)
    // Flowchart 모드
    flowchartModeActive: boolean;
    flowchartInitiator: string | null;
    flowchartOpenTime: number;
    // Flowchart 컨텍스트 (현재 화면 상태)
    flowchartContext?: {
        nodes: Array<{ id: string; content: string; nodeType: string; depth: number; branch: number }>;
        edges: Array<{ from: string; to: string; label?: string }>;
        summary: string;
    };

    // 시연용 이전 회의 컨텍스트
    previousMeetingContext?: {
        meetingTitle: string;
        summary: string;
        keyDecisions: string[];
        actionItems: string[];
        date: string;
    };
}

@Injectable()
export class VoiceBotService {
    private readonly logger = new Logger(VoiceBotService.name);
    private activeRooms: Map<string, RoomContext> = new Map();
    private processingLock: Map<string, boolean> = new Map();

    private readonly STOP_WORDS = ['멈춰', '그만', '스톱', '중지'];
    private readonly ARMED_TIMEOUT_MS = 30000;

    // ★ 대화 메모리 및 팔로업 관련 상수
    private readonly FOLLOW_UP_WINDOW_MS = 15000;     // 질문 후 15초간 웨이크워드 없이 응답 가능
    private readonly MAX_CONVERSATION_TURNS = 10;     // 최근 10턴까지 기억
    private readonly CONVERSATION_EXPIRE_MS = 300000; // 5분 지나면 대화 리셋

    constructor(
        private configService: ConfigService,
        private sttService: SttService,
        private llmService: LlmService,
        private ttsService: TtsService,
        @Inject(RAG_CLIENT) private ragClient: IRagClient,
        private intentClassifier: IntentClassifierService,
        private visionService: VisionService,
    ) { }

    async startBot(roomId: string, botToken: string): Promise<void> {
        if (this.activeRooms.has(roomId)) {
            this.logger.warn(`Bot already active in room: ${roomId}`);
            return;
        }

        const room = new Room();
        const rawUrl = this.configService.get<string>('LIVEKIT_URL');
        const livekitUrl = rawUrl.replace('http://', 'ws://').replace('https://', 'wss://');

        this.logger.log(`\n========== [AI 봇 시작] ==========`);
        this.logger.log(`방: ${roomId}, URL: ${livekitUrl}`);

        room.on(RoomEvent.TrackSubscribed, async (track: RemoteTrack, publication: RemoteTrackPublication, participant: RemoteParticipant) => {
            if (track.kind === TrackKind.KIND_AUDIO && !participant.identity.startsWith('ai-bot')) {
                this.logger.log(`[오디오 트랙 구독] ${participant.identity}`);
                await this.handleAudioTrack(roomId, track, participant.identity);
            }
            // 화면 공유 트랙 감지
            if (publication.source === TrackSource.SOURCE_SCREENSHARE) {
                this.logger.log(`[화면 공유 시작] ${participant.identity}`);
                const context = this.activeRooms.get(roomId);
                if (context) {
                    context.hasActiveScreenShare = true;
                }
            }
        });

        // 화면 공유 종료 감지
        room.on(RoomEvent.TrackUnsubscribed, (track: RemoteTrack, publication: RemoteTrackPublication, participant: RemoteParticipant) => {
            if (publication.source === TrackSource.SOURCE_SCREENSHARE) {
                this.logger.log(`[화면 공유 종료] ${participant.identity}`);
                const context = this.activeRooms.get(roomId);
                if (context) {
                    context.hasActiveScreenShare = false;
                    context.isVisionMode = false;
                }
            }
        });

        // DataChannel 메시지 수신 (Vision 캡처 응답)
        room.on(RoomEvent.DataReceived, async (payload: Uint8Array, participant?: RemoteParticipant) => {
            try {
                const message = JSON.parse(new TextDecoder().decode(payload));
                this.logger.debug(`[DataChannel] 메시지 수신 from ${participant?.identity || 'unknown'}: type=${message.type}`);
                if (message.type === 'vision_capture_response') {
                    this.logger.log(`[Vision] 캡처 응답 수신 - requestId: ${message.requestId}, 이미지 크기: ${(message.imageBase64?.length / 1024).toFixed(1)}KB`);
                    await this.handleVisionCaptureResponse(roomId, message);
                }
            } catch (error) {
                // JSON 파싱 실패 시 무시 (다른 타입의 DataChannel 메시지일 수 있음)
                this.logger.debug(`[DataChannel] 파싱 실패 또는 비-JSON 메시지`);
            }
        });

        room.on(RoomEvent.ParticipantConnected, (participant: RemoteParticipant) => {
            this.logger.log(`[참여자 입장] ${participant.identity}`);

            // 인간 참여자 입장 시 셧다운 취소
            if (!participant.identity.startsWith('ai-bot')) {
                const context = this.activeRooms.get(roomId);
                if (context?.shutdownTimeout) {
                    this.logger.log(`[셧다운 취소] 인간 참여자 재입장`);
                    clearTimeout(context.shutdownTimeout);
                    context.shutdownTimeout = undefined;
                }
            }
        });

        room.on(RoomEvent.ParticipantDisconnected, (participant: RemoteParticipant) => {
            this.logger.log(`[참여자 퇴장] ${participant.identity}`);

            const humanCount = Array.from(room.remoteParticipants.values())
                .filter(p => !p.identity.startsWith('ai-bot')).length;

            if (humanCount === 0) {
                const context = this.activeRooms.get(roomId);
                if (context) {
                    // 이미 예약된 셧다운이 있으면 무시 (또는 갱신)
                    if (context.shutdownTimeout) {
                        return;
                    }
                    this.logger.log(`[자동 퇴장 예약] 인간 참여자 없음 - 30초 후 종료`);
                    context.shutdownTimeout = setTimeout(() => {
                        // 타임아웃 실행 시점에도 여전히 사람이 없으면 종료
                        const currentContext = this.activeRooms.get(roomId);
                        if (currentContext) {
                            const currentHumanCount = Array.from(context.room.remoteParticipants.values())
                                .filter(p => !p.identity.startsWith('ai-bot')).length;

                            if (currentHumanCount === 0) {
                                this.logger.log(`[자동 퇴장 실행] 유예 시간 30초 경과`);
                                this.stopBot(roomId);
                            } else {
                                this.logger.log(`[자동 퇴장 취소] 셧다운 직전 인간 참여자 확인됨`);
                                currentContext.shutdownTimeout = undefined;
                            }
                        }
                    }, 30000); // 30초 유예
                }
            }
        });

        room.on(RoomEvent.Disconnected, (reason?: any) => {
            this.logger.warn(`[봇 연결 끊김] 사유: ${reason || 'UNKNOWN'}`);
            this.cleanupRoom(roomId);
        });

        // 아이디어 모드 시작/종료 메시지 수신 (디바운싱 적용)
        const MODE_CHANGE_DEBOUNCE_MS = 500; // 500ms 내 중복 변경 무시

        room.on(RoomEvent.DataReceived, (payload: Uint8Array, participant: any) => {
            try {
                const message = JSON.parse(new TextDecoder().decode(payload));

                // ★ 모든 DataChannel 메시지 로그
                this.logger.debug(`[DataChannel 수신] type=${message.type}, from=${participant?.identity || 'unknown'}`);

                const context = this.activeRooms.get(roomId);
                if (!context) {
                    this.logger.warn(`[DataChannel] context 없음 - 메시지 무시: ${message.type}`);
                    return;
                }

                const now = Date.now();

                if (message.type === 'IDEA_MODE_START') {
                    // 이미 ON이면 무시
                    if (context.ideaModeActive) {
                        this.logger.debug(`[모드 변경] 아이디어 START 무시 (이미 ON)`);
                        return;
                    }
                    // 디바운싱: 최근에 변경됐으면 무시
                    if (now - context.lastIdeaModeChange < MODE_CHANGE_DEBOUNCE_MS) {
                        this.logger.debug(`[모드 변경] 아이디어 START 무시 (디바운싱)`);
                        return;
                    }
                    context.ideaModeActive = true;
                    context.lastIdeaModeChange = now;
                    this.logger.log(`[모드 변경] 아이디어 모드 ON by ${participant?.identity || 'unknown'}`);
                } else if (message.type === 'IDEA_MODE_END') {
                    // 이미 OFF면 타임스탬프 업데이트 안 함 (START 차단 방지)
                    if (!context.ideaModeActive) {
                        this.logger.debug(`[모드 변경] 아이디어 END 무시 (이미 OFF)`);
                        return;
                    }
                    if (now - context.lastIdeaModeChange < MODE_CHANGE_DEBOUNCE_MS) {
                        this.logger.debug(`[모드 변경] 아이디어 END 무시 (디바운싱)`);
                        return;
                    }
                    context.ideaModeActive = false;
                    context.lastIdeaModeChange = now;
                    this.logger.log(`[모드 변경] 아이디어 모드 OFF`);
                } else if (message.type === 'FLOWCHART_START') {
                    const senderId = participant?.identity || 'unknown';
                    if (context.flowchartModeActive) {
                        this.logger.debug(`[모드 변경] Flowchart START 무시 - 이미 ON`);
                        return;
                    }
                    context.flowchartModeActive = true;
                    context.flowchartInitiator = senderId;
                    context.flowchartOpenTime = now;
                    this.logger.log(`[모드 변경] Flowchart ON by ${senderId}`);
                } else if (message.type === 'FLOWCHART_END') {
                    const senderId = participant?.identity || 'unknown';
                    if (!context.flowchartModeActive) {
                        this.logger.debug(`[모드 변경] Flowchart END 무시 (이미 OFF)`);
                        return;
                    }
                    // Grace period 체크
                    const OPEN_GRACE_PERIOD_MS = 1000;
                    if (context.flowchartOpenTime > 0 && now - context.flowchartOpenTime < OPEN_GRACE_PERIOD_MS) {
                        this.logger.debug(`[모드 변경] Flowchart END 무시 (grace period)`);
                        return;
                    }
                    context.flowchartModeActive = false;
                    context.flowchartInitiator = null;
                    context.flowchartOpenTime = 0;
                    this.logger.log(`[모드 변경] Flowchart OFF by ${senderId}`);
                } else if (message.type === 'CDR_FLOWCHART_REQUEST') {
                    // CDR → Flowchart 변환 요청
                    this.logger.log(`[CDR→Flowchart] 요청 수신 - ${message.content?.length || 0}자`);
                    this.handleCDRFlowchartRequest(
                        roomId,
                        message.content || '',
                        message.preserveExisting ?? true,
                        message.requesterId || participant?.identity || 'unknown'
                    );
                } else if (message.type === 'CDR_ANALYSIS_REQUEST') {
                    // CDR 종합 분석 요청 (Domain Model + Flowchart + ER Diagram)
                    this.logger.log(`[CDR 분석] 요청 수신 - ${message.content?.length || 0}자`);
                    this.handleCDRAnalysisRequest(
                        roomId,
                        message.content || '',
                        message.preserveExisting ?? true,
                        message.requesterId || participant?.identity || 'unknown'
                    );
                } else if (message.type === 'SKELETON_CODE_REQUEST') {
                    // Skeleton 코드 생성 요청
                    this.logger.log(`[Skeleton] 요청 수신 - ${message.nodes?.length || 0}개 노드`);
                    this.handleSkeletonCodeRequest(
                        roomId,
                        message.nodes || [],
                        message.edges || [],
                        message.language || 'python',
                        message.requesterId || participant?.identity || 'unknown'
                    );
                } else if (message.type === 'FLOWCHART_CONTEXT') {
                    // Flowchart 컨텍스트 업데이트 (현재 화면 상태)
                    this.logger.log(`[Flowchart 컨텍스트] 업데이트 - 노드: ${message.nodes?.length || 0}, 엣지: ${message.edges?.length || 0}`);
                    context.flowchartContext = {
                        nodes: message.nodes || [],
                        edges: message.edges || [],
                        summary: message.summary || '',
                    };
                    // Flowchart가 열려있으면 자동으로 모드 활성화
                    if (!context.flowchartModeActive && message.nodes?.length > 0) {
                        context.flowchartModeActive = true;
                        this.logger.log(`[모드 변경] Flowchart 자동 활성화 (컨텍스트 수신)`);
                    }
                }
            } catch (error) {
                // JSON 파싱 실패는 무시 (다른 메시지일 수 있음)
            }
        });

        try {
            await room.connect(livekitUrl, botToken);

            // RAG 연결은 비동기로 처리 (방 입장을 블로킹하지 않음)
            this.ragClient.connect(roomId)
                .then(() => this.logger.log(`[RAG 연결 완료] ${roomId}`))
                .catch((error) => this.logger.warn(`[RAG 연결 실패] ${roomId}: ${error.message} - RAG 없이 계속 진행`));

            const audioSource = new AudioSource(16000, 1);
            const localAudioTrack = LocalAudioTrack.createAudioTrack('ai-voice', audioSource);

            const publishOptions = new TrackPublishOptions();
            publishOptions.source = TrackSource.SOURCE_MICROPHONE;
            await room.localParticipant.publishTrack(localAudioTrack, publishOptions);
            this.logger.log(`[오디오 트랙 발행 완료]`);

            const context: RoomContext = {
                room,
                audioSource,
                localAudioTrack,
                isPublishing: false,
                shouldInterrupt: false,
                currentRequestId: 0,
                botState: BotState.SLEEP,
                lastInteractionTime: Date.now(),
                lastSttTimeByUser: new Map(),
                lastResponseTime: 0,
                lastSpeechTime: 0,
                speakingStartTime: 0,
                activeUserId: null,
                // Vision 관련 초기화
                hasActiveScreenShare: false,
                isVisionMode: false,
                // 아이디어 모드 초기화
                ideaModeActive: false,
                lastIdeaModeChange: 0,
                eventStormModeActive: false,
                eventStormInitiator: null,
                eventStormOpenTime: 0,
                lastEventStormStart: 0,
                lastEventStormEnd: 0,
                isDddProcessing: false,
                lastDddText: '',
                // ★ 대화 메모리 및 팔로업 초기화
                conversationHistory: [],
                isInFollowUpWindow: false,
                followUpExpiresAt: 0,
                lastBotQuestion: null,
                // Flowchart 모드 초기화
                flowchartModeActive: false,
                flowchartInitiator: null,
                flowchartOpenTime: 0,
            };
            this.activeRooms.set(roomId, context);

            this.startArmedTimeoutChecker(roomId);

            this.logger.log(`[봇 입장 성공] 참여자: ${room.remoteParticipants.size}명`);

            // 입장 인사 (캘리브레이션 동안 TTS로 시간 벌기)
            await this.greetOnJoin(roomId);

            // 기존 참여자의 오디오 트랙 처리
            for (const participant of room.remoteParticipants.values()) {
                if (!participant.identity.startsWith('ai-bot')) {
                    for (const publication of participant.trackPublications.values()) {
                        if (publication.track && publication.kind === TrackKind.KIND_AUDIO) {
                            await this.handleAudioTrack(roomId, publication.track as RemoteTrack, participant.identity);
                        }
                    }
                }
            }
        } catch (error) {
            this.logger.error(`[봇 입장 실패] ${error.message}`);
            throw error;
        }
    }

    /**
     * 방 입장 시 인사 (캘리브레이션 시간 확보)
     */
    private async greetOnJoin(roomId: string): Promise<void> {
        const context = this.activeRooms.get(roomId);
        if (!context) return;

        // 인사 멘트 (캘리브레이션 3초 동안 TTS)
        const greetings = [
            '안녕하세요! 아우라예요. 회의 시작하면 불러주세요~',
            '안녕하세요~ 아우라 들어왔어요! 필요하면 불러주세요.',
            '안녕하세요! 아우라예요, 뭐든 물어봐 주세요~',
        ];
        const greeting = greetings[Math.floor(Math.random() * greetings.length)];

        try {
            this.logger.log(`[입장 인사] "${greeting}"`);
            context.botState = BotState.SPEAKING;

            const pcmBuffer = await this.ttsService.synthesizePcm(greeting);
            if (pcmBuffer && pcmBuffer.length > 0) {
                await this.publishAudio(roomId, context.audioSource, pcmBuffer);
            }

            context.botState = BotState.SLEEP;
            context.lastResponseTime = Date.now();
            this.logger.log(`[입장 인사 완료]`);
        } catch (error) {
            this.logger.warn(`[입장 인사 실패] ${error.message}`);
            context.botState = BotState.SLEEP;
        }
    }


    // 아이디어 감지 및 브로드캐스트
    // =====================================================

    /**
     * 아이디어 모드: 발화를 간단히 요약해서 포스트잇으로 전송
     * - 최소 필터만 적용 (짧은 발화, 추임새만 스킵)
     * - 나머지는 모두 포스트잇으로 전송
     */
    private async detectAndBroadcastIdea(
        roomId: string,
        context: RoomContext,
        transcript: string,
        userId: string
    ): Promise<void> {
        // 너무 짧은 발화 스킵 (3글자 이하)
        if (transcript.length <= 3) {
            this.logger.log(`[아이디어] 스킵 - 너무 짧음: "${transcript}"`);
            return;
        }

        // 단순 인사/추임새 필터링 (최소한만)
        const skipPatterns = /^(안녕|네|응|어|음|아|예|오케이|ㅇㅇ|ㅋ+|하하|그래|알겠|뭐지|뭐야|아아|으으|에에)[\.\?\!]?$/i;
        if (skipPatterns.test(transcript.trim())) {
            this.logger.log(`[아이디어] 스킵 - 추임새: "${transcript}"`);
            return;
        }

        // 간단한 요약: 웨이크워드 제거 + 핵심만 추출
        let ideaContent = this.extractIdeaContent(transcript);

        if (!ideaContent || ideaContent.length < 2) {
            this.logger.log(`[아이디어] 스킵 - 추출 실패: "${transcript}"`);
            return;
        }

        // 15자 초과시 자르기
        if (ideaContent.length > 15) {
            ideaContent = ideaContent.substring(0, 15);
        }

        this.logger.log(`[아이디어 감지] "${ideaContent}" (원본: "${transcript}")`);

        // DataChannel로 브로드캐스트
        const ideaMessage = {
            type: 'NEW_IDEA',
            idea: {
                id: `idea-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
                content: ideaContent,
                author: userId || '익명',
            },
        };

        const encoder = new TextEncoder();
        await context.room.localParticipant.publishData(
            encoder.encode(JSON.stringify(ideaMessage)),
            { reliable: true }
        );

        this.logger.log(`[아이디어 전송] "${ideaContent}" by ${userId}`);
    }

    /**
     * 발화에서 아이디어 핵심 추출 (LLM 없이 패턴 기반)
     */
    private extractIdeaContent(transcript: string): string {
        let text = transcript.trim();

        // 웨이크워드 제거
        text = text.replace(/^(아우라야?|아우라|오라야?)\s*/i, '');

        // 질문형 어미 제거
        text = text.replace(/[\?\!\.]+$/, '');
        text = text.replace(/(은|는)?\s*(어때|어떨까|어떨까요|어때요|좋을까|좋겠다|하면|해볼까|해보자|하자)\s*$/g, '');
        text = text.replace(/\s*(아이디어|생각|의견)\s*$/g, '');

        // 불필요한 접두사 제거
        text = text.replace(/^(그|저|이|그러면|아|어|음|근데|그래서|그런데)\s+/g, '');

        // 조사 정리
        text = text.replace(/\s+(을|를|이|가|은|는|의|에|로|으로)\s*$/g, '');

        return text.trim();
    }

    // =====================================================
    // CDR → Flowchart 파싱
    // =====================================================

    // Flowchart 노드 타입 (Mermaid 스타일)
    private readonly FLOWCHART_NODE_TYPES = ['start', 'end', 'process', 'decision', 'io'] as const;

    /**
     * CDR 문서를 Flowchart 노드로 변환
     */
    private async parseCDRToFlowchart(cdrContent: string): Promise<{
        success: boolean;
        nodes: { id: string; content: string; nodeType: string; order: number; depth: number; branch: number }[];
        edges: { from: string; to: string; label?: string }[];
        summary?: string;
        error?: string;
    }> {
        try {
            // CDR 텍스트 전처리 (너무 긴 경우 압축)
            const processedContent = cdrContent.length > 5000
                ? cdrContent.substring(0, 5000) + '\n... (이하 생략)'
                : cdrContent;

            const prompt = `CDR(요구사항 문서)를 Flowchart로 변환해주세요.

입력 CDR:
"""
${processedContent}
"""

노드 타입 (Mermaid 스타일):
- start: 시작점 (타원형)
- end: 종료점 (타원형)
- process: 일반 처리/동작 (사각형)
- decision: 조건 분기 (마름모) - Yes/No 분기
- io: 입출력 (평행사변형)

규칙:
1. 노드 content는 15자 이내로 핵심만 추출
2. 반드시 start로 시작하고 end로 끝나야 함
3. decision 노드에서 나가는 edge는 label에 "Yes" 또는 "No" 표시
4. 연결(edges)의 from/to는 노드 id로 참조

출력 형식 (JSON만):
{"nodes":[{"id":"n1","content":"시작","nodeType":"start"},{"id":"n2","content":"입력","nodeType":"io"},{"id":"n3","content":"조건?","nodeType":"decision"},{"id":"n4","content":"처리A","nodeType":"process"},{"id":"n5","content":"처리B","nodeType":"process"},{"id":"n6","content":"종료","nodeType":"end"}],"edges":[{"from":"n1","to":"n2"},{"from":"n2","to":"n3"},{"from":"n3","to":"n4","label":"Yes"},{"from":"n3","to":"n5","label":"No"},{"from":"n4","to":"n6"},{"from":"n5","to":"n6"}],"summary":"조건 분기 흐름"}`;

            this.logger.log(`[CDR→Flowchart] LLM 호출 시작 (${processedContent.length}자)`);
            const answer = await this.llmService.sendMessagePure(prompt, 2000);
            this.logger.debug(`[CDR→Flowchart] LLM 응답: ${answer.substring(0, 200)}...`);

            // JSON 파싱 시도
            const jsonMatch = answer.match(/\{[\s\S]*\}/);
            if (!jsonMatch) {
                this.logger.warn(`[CDR→Flowchart] JSON 패턴 없음`);
                return { success: false, nodes: [], edges: [], error: 'JSON 패턴을 찾을 수 없습니다' };
            }

            const parsed = JSON.parse(jsonMatch[0]);

            // 기본 노드/엣지 파싱
            const rawNodes = (parsed.nodes || []).filter((n: any) =>
                n && n.id && n.content && this.FLOWCHART_NODE_TYPES.includes(n.nodeType)
            );

            const edges = (parsed.edges || []).filter((e: any) =>
                e && e.from && e.to
            ).map((e: any) => ({
                from: e.from,
                to: e.to,
                label: e.label,
            }));

            // ★ 그래프 분석하여 depth와 branch 계산
            const nodeMap = new Map<string, any>();
            rawNodes.forEach((n: any) => nodeMap.set(n.id, n));

            // 들어오는 엣지 수 계산 (indegree)
            const inDegree = new Map<string, number>();
            rawNodes.forEach((n: any) => inDegree.set(n.id, 0));
            edges.forEach((e: any) => {
                inDegree.set(e.to, (inDegree.get(e.to) || 0) + 1);
            });

            // BFS로 depth 계산
            const depthMap = new Map<string, number>();
            const branchMap = new Map<string, number>();

            // 시작 노드 찾기 (indegree가 0인 노드)
            let startNodeId = rawNodes.find((n: any) => n.nodeType === 'start')?.id;
            if (!startNodeId) {
                startNodeId = rawNodes.find((n: any) => inDegree.get(n.id) === 0)?.id;
            }

            if (startNodeId) {
                const queue: { id: string; depth: number; branch: number }[] = [
                    { id: startNodeId, depth: 0, branch: 0 }
                ];
                const visited = new Set<string>();

                while (queue.length > 0) {
                    const { id, depth, branch } = queue.shift()!;
                    if (visited.has(id)) continue;
                    visited.add(id);

                    depthMap.set(id, depth);
                    branchMap.set(id, branch);

                    // 나가는 엣지 찾기
                    const outEdges = edges.filter((e: any) => e.from === id);

                    if (outEdges.length === 1) {
                        // 단일 경로
                        queue.push({ id: outEdges[0].to, depth: depth + 1, branch });
                    } else if (outEdges.length >= 2) {
                        // 분기 (Yes/No 또는 여러 경로)
                        outEdges.forEach((e: any, idx: number) => {
                            const branchOffset = idx === 0 ? -1 : (idx === 1 ? 1 : idx - 1);
                            queue.push({ id: e.to, depth: depth + 1, branch: branchOffset });
                        });
                    }
                }
            }

            // 최종 노드 생성
            const nodes = rawNodes.map((n: any, idx: number) => ({
                id: n.id || `node-${Date.now()}-${idx}`,
                content: String(n.content).substring(0, 30),
                nodeType: n.nodeType,
                order: idx,
                depth: depthMap.get(n.id) ?? idx,
                branch: branchMap.get(n.id) ?? 0,
            }));

            this.logger.log(`[CDR→Flowchart 완료] ${nodes.length}개 노드, ${edges.length}개 연결`);

            return {
                success: true,
                nodes,
                edges,
                summary: parsed.summary,
            };
        } catch (error) {
            this.logger.error(`[CDR→Flowchart 실패] ${error.message}`);
            return {
                success: false,
                nodes: [],
                edges: [],
                error: error.message,
            };
        }
    }

    /**
     * CDR Flowchart 파싱 요청 처리 및 응답 전송
     */
    private async handleCDRFlowchartRequest(
        roomName: string,
        content: string,
        preserveExisting: boolean,
        requesterId: string
    ): Promise<void> {
        const context = this.activeRooms.get(roomName);
        if (!context) return;

        this.logger.log(`[CDR→Flowchart] 요청 처리 from ${requesterId}: ${content.length}자`);

        const result = await this.parseCDRToFlowchart(content);

        // 응답 전송
        const responseMessage = {
            type: 'CDR_FLOWCHART_RESPONSE',
            ...result,
            preserveExisting,
        };

        const encoder = new TextEncoder();
        await context.room.localParticipant.publishData(
            encoder.encode(JSON.stringify(responseMessage)),
            { reliable: true }
        );

        this.logger.log(`[CDR→Flowchart] 응답 전송: ${result.nodes.length}개 노드`);
    }

    // =====================================================
    // Domain Model & ER Diagram 추출
    // =====================================================

    /**
     * CDR 문서에서 Domain Model 추출
     */
    private async extractDomainModel(cdrContent: string): Promise<{
        success: boolean;
        domainModel?: {
            entities: { name: string; attributes: string[]; description?: string }[];
            actions: { name: string; actor: string; target: string; description?: string }[];
            conditions: { name: string; trueAction: string; falseAction: string }[];
            relations: { from: string; to: string; type: '1:1' | '1:N' | 'N:M'; label?: string }[];
        };
        error?: string;
    }> {
        try {
            const processedContent = cdrContent.length > 5000
                ? cdrContent.substring(0, 5000) + '\n... (이하 생략)'
                : cdrContent;

            const prompt = `CDR(요구사항 문서)에서 도메인 모델을 추출해주세요.

입력 CDR:
"""
${processedContent}
"""

다음 요소들을 추출해주세요:

1. entities: 시스템의 핵심 엔티티 (명사)
   - name: 엔티티 이름 (예: User, Order, Product)
   - attributes: 주요 속성들 (예: ["id", "email", "name"])
   - description: 간단한 설명

2. actions: 주요 행위/동작 (동사)
   - name: 액션 이름 (예: "주문생성", "결제처리")
   - actor: 수행 주체 (예: "User")
   - target: 대상 엔티티 (예: "Order")
   - description: 간단한 설명

3. conditions: 비즈니스 조건/규칙
   - name: 조건 이름 (예: "재고확인")
   - trueAction: 참일 때 수행할 액션
   - falseAction: 거짓일 때 수행할 액션

4. relations: 엔티티 간 관계
   - from: 시작 엔티티
   - to: 끝 엔티티
   - type: "1:1" | "1:N" | "N:M"
   - label: 관계 설명 (예: "주문하다", "포함하다")

JSON만 출력:
{"entities":[...],"actions":[...],"conditions":[...],"relations":[...]}`;

            this.logger.log(`[Domain Model] 추출 시작 (${processedContent.length}자)`);
            const answer = await this.llmService.sendMessagePure(prompt, 2000);

            const jsonMatch = answer.match(/\{[\s\S]*\}/);
            if (!jsonMatch) {
                return { success: false, error: 'JSON 패턴을 찾을 수 없습니다' };
            }

            const parsed = JSON.parse(jsonMatch[0]);

            const domainModel = {
                entities: (parsed.entities || []).map((e: any) => ({
                    name: e.name || '',
                    attributes: Array.isArray(e.attributes) ? e.attributes : [],
                    description: e.description,
                })),
                actions: (parsed.actions || []).map((a: any) => ({
                    name: a.name || '',
                    actor: a.actor || '',
                    target: a.target || '',
                    description: a.description,
                })),
                conditions: (parsed.conditions || []).map((c: any) => ({
                    name: c.name || '',
                    trueAction: c.trueAction || '',
                    falseAction: c.falseAction || '',
                })),
                relations: (parsed.relations || []).map((r: any) => ({
                    from: r.from || '',
                    to: r.to || '',
                    type: ['1:1', '1:N', 'N:M'].includes(r.type) ? r.type : '1:N',
                    label: r.label,
                })),
            };

            this.logger.log(`[Domain Model 완료] 엔티티: ${domainModel.entities.length}, 액션: ${domainModel.actions.length}`);
            return { success: true, domainModel };
        } catch (error) {
            this.logger.error(`[Domain Model 실패] ${error.message}`);
            return { success: false, error: error.message };
        }
    }

    /**
     * Domain Model에서 ER Diagram (Mermaid) 생성
     */
    private generateERDiagram(domainModel: {
        entities: { name: string; attributes: string[] }[];
        relations: { from: string; to: string; type: string; label?: string }[];
    }): { success: boolean; mermaidCode: string; error?: string } {
        try {
            if (!domainModel.entities || domainModel.entities.length === 0) {
                return { success: false, mermaidCode: '', error: '엔티티가 없습니다' };
            }

            let mermaid = 'erDiagram\n';

            // 엔티티 정의
            for (const entity of domainModel.entities) {
                mermaid += `    ${entity.name} {\n`;
                for (const attr of entity.attributes.slice(0, 8)) {
                    // 속성 이름 정제 (공백, 특수문자 제거)
                    const cleanAttr = attr.replace(/[^a-zA-Z0-9가-힣_]/g, '_');
                    mermaid += `        string ${cleanAttr}\n`;
                }
                mermaid += `    }\n`;
            }

            // 관계 정의
            for (const rel of domainModel.relations) {
                const fromEntity = domainModel.entities.find(e => e.name === rel.from);
                const toEntity = domainModel.entities.find(e => e.name === rel.to);

                if (fromEntity && toEntity) {
                    let relSymbol = '||--o{'; // 기본 1:N
                    if (rel.type === '1:1') relSymbol = '||--||';
                    else if (rel.type === 'N:M') relSymbol = '}o--o{';

                    const label = rel.label || '';
                    mermaid += `    ${rel.from} ${relSymbol} ${rel.to} : "${label}"\n`;
                }
            }

            this.logger.log(`[ER Diagram] 생성 완료 (${domainModel.entities.length}개 엔티티)`);
            return { success: true, mermaidCode: mermaid };
        } catch (error) {
            this.logger.error(`[ER Diagram 실패] ${error.message}`);
            return { success: false, mermaidCode: '', error: error.message };
        }
    }

    /**
     * CDR 종합 분석 요청 처리 (Domain Model + Flowchart + ER Diagram)
     */
    private async handleCDRAnalysisRequest(
        roomName: string,
        content: string,
        preserveExisting: boolean,
        requesterId: string
    ): Promise<void> {
        const context = this.activeRooms.get(roomName);
        if (!context) return;

        this.logger.log(`[CDR 분석] 종합 분석 시작 from ${requesterId}: ${content.length}자`);

        // 병렬로 Domain Model과 Flowchart 추출
        const [domainModelResult, flowchartResult] = await Promise.all([
            this.extractDomainModel(content),
            this.parseCDRToFlowchart(content),
        ]);

        // ER Diagram 생성 (Domain Model 결과 사용)
        let erDiagramResult: { success: boolean; mermaidCode: string; error?: string } = {
            success: false,
            mermaidCode: '',
            error: 'Domain Model 추출 실패'
        };
        if (domainModelResult.success && domainModelResult.domainModel) {
            erDiagramResult = this.generateERDiagram(domainModelResult.domainModel);
        }

        // 응답 전송
        const responseMessage = {
            type: 'CDR_ANALYSIS_RESPONSE',
            domainModel: domainModelResult.success ? domainModelResult.domainModel : null,
            flowchart: flowchartResult.success ? {
                nodes: flowchartResult.nodes,
                edges: flowchartResult.edges,
                summary: flowchartResult.summary,
            } : null,
            erDiagram: erDiagramResult.success ? {
                mermaidCode: erDiagramResult.mermaidCode,
            } : null,
            preserveExisting,
            errors: {
                domainModel: domainModelResult.error,
                flowchart: flowchartResult.error,
                erDiagram: erDiagramResult.error,
            },
        };

        const encoder = new TextEncoder();
        await context.room.localParticipant.publishData(
            encoder.encode(JSON.stringify(responseMessage)),
            { reliable: true }
        );

        this.logger.log(`[CDR 분석] 응답 전송 - DM: ${domainModelResult.success}, FC: ${flowchartResult.success}, ER: ${erDiagramResult.success}`);
    }

    /**
     * Flowchart에서 Skeleton 코드 생성
     */
    private async generateSkeletonCode(
        nodes: { id: string; content: string; nodeType: string }[],
        edges: { from: string; to: string; label?: string }[],
        language: string = 'python'
    ): Promise<{ success: boolean; code: string; error?: string }> {
        try {
            const flowchartDesc = nodes.map(n => `- ${n.id}: ${n.content} (${n.nodeType})`).join('\n');
            const edgesDesc = edges.map(e => `- ${e.from} → ${e.to}${e.label ? ` [${e.label}]` : ''}`).join('\n');

            const prompt = `Flowchart를 기반으로 ${language} skeleton 코드를 생성해주세요.

Flowchart 노드:
${flowchartDesc}

연결:
${edgesDesc}

규칙:
1. 함수/클래스 구조만 생성 (구현은 TODO 주석)
2. process 노드 → 함수로 변환
3. decision 노드 → if/else 구조
4. io 노드 → 입출력 함수
5. 각 함수에 docstring/주석 추가
6. main 함수에서 전체 흐름 호출

코드만 출력 (설명 없이):`;

            this.logger.log(`[Skeleton] 코드 생성 시작 (${language})`);
            const code = await this.llmService.sendMessagePure(prompt, 2000);

            // 코드 블록 추출
            const codeMatch = code.match(/```[\w]*\n([\s\S]*?)```/) || [null, code];
            const cleanCode = codeMatch[1]?.trim() || code.trim();

            return { success: true, code: cleanCode };
        } catch (error) {
            this.logger.error(`[Skeleton] 코드 생성 실패: ${error.message}`);
            return { success: false, code: '', error: error.message };
        }
    }

    /**
     * Skeleton 코드 생성 요청 처리
     */
    private async handleSkeletonCodeRequest(
        roomName: string,
        nodes: any[],
        edges: any[],
        language: string,
        requesterId: string
    ): Promise<void> {
        const context = this.activeRooms.get(roomName);
        if (!context) return;

        this.logger.log(`[Skeleton] 요청 처리 from ${requesterId}: ${nodes.length}개 노드, ${language}`);

        const result = await this.generateSkeletonCode(nodes, edges, language);

        const responseMessage = {
            type: 'SKELETON_CODE_RESPONSE',
            ...result,
            language,
        };

        const encoder = new TextEncoder();
        await context.room.localParticipant.publishData(
            encoder.encode(JSON.stringify(responseMessage)),
            { reliable: true }
        );

        this.logger.log(`[Skeleton] 응답 전송: ${result.success ? '성공' : '실패'}`);
    }

    // =====================================================
    // 오디오 처리
    // =====================================================

    private async handleAudioTrack(roomId: string, track: RemoteTrack, userId: string) {
        this.logger.log(`[오디오 처리 시작] ${userId}`);

        const audioStream = new AudioStream(track, 16000, 1);

        // 캘리브레이션 변수
        let isCalibrating = true;
        let calibrationSamples: number[] = [];
        const calibrationStartTime = Date.now();
        const CALIBRATION_DURATION = 3000;

        // VAD 변수
        let audioBuffer: Buffer[] = [];
        let silenceCount = 0;
        let voiceCount = 0;

        const SILENCE_THRESHOLD = 50;  // 무음 프레임 수 (~500ms)
        const MIN_AUDIO_LENGTH = 16000;  // 최소 0.5초 (16000/32000)
        const MAX_AUDIO_LENGTH = 192000;  // 최대 6초 (192000/32000) - 긴 문장 완전 인식
        const MIN_VOICE_FRAMES = 8;
        const BARGE_IN_DECIBEL_THRESHOLD = -20;
        const STRONG_VOICE_THRESHOLD = -24;
        const STT_COOLDOWN_MS = 1200;

        let MIN_DECIBEL_THRESHOLD = -45;
        let VOICE_AMPLITUDE_THRESHOLD = 500;

        let backgroundNoiseDB = -60;
        const NOISE_UPDATE_ALPHA = 0.05;
        const VOICE_MARGIN_DB = 10;

        let speakerVoiceDB = -30;
        let speakerSampleCount = 0;
        const SPEAKER_UPDATE_ALPHA = 0.15;
        const MIN_SPEAKER_SAMPLES = 3;

        const context = this.activeRooms.get(roomId);

        for await (const frame of audioStream) {
            const frameBuffer = Buffer.from(frame.data.buffer);
            const samples = new Int16Array(frame.data.buffer);

            const rms = Math.sqrt(
                samples.reduce((sum, s) => sum + s * s, 0) / samples.length
            );
            const decibel = 20 * Math.log10(rms / 32768);
            const avgAmplitude = samples.reduce((sum, s) => sum + Math.abs(s), 0) / samples.length;

            // 캘리브레이션
            if (isCalibrating) {
                const elapsed = Date.now() - calibrationStartTime;
                if (elapsed < CALIBRATION_DURATION) {
                    if (decibel > -90 && decibel < 0) {
                        calibrationSamples.push(decibel);
                    }
                    continue;
                } else {
                    if (calibrationSamples.length > 0) {
                        backgroundNoiseDB = calibrationSamples.reduce((sum, db) => sum + db, 0) / calibrationSamples.length;
                        MIN_DECIBEL_THRESHOLD = backgroundNoiseDB + VOICE_MARGIN_DB;
                        const noiseRMS = 32768 * Math.pow(10, backgroundNoiseDB / 20);
                        VOICE_AMPLITUDE_THRESHOLD = Math.max(300, Math.min(800, noiseRMS * 3));
                        this.logger.log(`[캘리브레이션] 배경 소음: ${backgroundNoiseDB.toFixed(1)}dB`);
                    }
                    isCalibrating = false;
                }
            }

            // 배경 소음 동적 업데이트
            if (!isCalibrating && decibel < MIN_DECIBEL_THRESHOLD - 5) {
                backgroundNoiseDB = backgroundNoiseDB * (1 - NOISE_UPDATE_ALPHA) + decibel * NOISE_UPDATE_ALPHA;
            }

            const isVoice = avgAmplitude > VOICE_AMPLITUDE_THRESHOLD && decibel > MIN_DECIBEL_THRESHOLD;

            // 화자 음성 레벨 학습
            if (!isCalibrating && isVoice) {
                speakerVoiceDB = speakerVoiceDB * (1 - SPEAKER_UPDATE_ALPHA) + decibel * SPEAKER_UPDATE_ALPHA;
                speakerSampleCount++;

                if (speakerSampleCount >= MIN_SPEAKER_SAMPLES) {
                    const optimalThreshold = backgroundNoiseDB + (speakerVoiceDB - backgroundNoiseDB) * 0.3;
                    if (Math.abs(optimalThreshold - MIN_DECIBEL_THRESHOLD) > 2) {
                        MIN_DECIBEL_THRESHOLD = optimalThreshold;
                        const thresholdRMS = 32768 * Math.pow(10, MIN_DECIBEL_THRESHOLD / 20);
                        VOICE_AMPLITUDE_THRESHOLD = Math.max(300, Math.min(800, thresholdRMS * 1.5));
                    }
                }
            }

            // 봇 발화 중 처리
            if (context?.isPublishing && context.botState !== BotState.SPEAKING) {
                continue;
            }

            // Barge-in 감지
            if (context?.isPublishing && context.botState === BotState.SPEAKING) {
                const BARGE_IN_GRACE_PERIOD_MS = 500;
                const timeSinceSpeakingStart = Date.now() - context.speakingStartTime;

                if (timeSinceSpeakingStart < BARGE_IN_GRACE_PERIOD_MS) {
                    continue;
                }

                if (isVoice && voiceCount >= MIN_VOICE_FRAMES && !context.shouldInterrupt &&
                    decibel > BARGE_IN_DECIBEL_THRESHOLD &&
                    (context.activeUserId === null || context.activeUserId === userId)) {
                    this.logger.log(`[Barge-in] ${userId} 끼어들기 감지`);
                    context.shouldInterrupt = true;
                }
                continue;
            }

            // VAD 처리
            if (isVoice) {
                voiceCount++;
                if (context && voiceCount >= MIN_VOICE_FRAMES) {
                    context.lastInteractionTime = Date.now();
                }
                if (decibel > STRONG_VOICE_THRESHOLD) {
                    silenceCount = 0;
                }
                audioBuffer.push(frameBuffer);
            } else if (avgAmplitude > 150 && decibel > -55) {
                audioBuffer.push(frameBuffer);
                silenceCount++;
            } else {
                silenceCount++;
                voiceCount = 0;
            }

            // 발화 종료 감지 → STT 요청
            const totalLength = audioBuffer.reduce((sum, b) => sum + b.length, 0);
            const triggeredBySilence = silenceCount > SILENCE_THRESHOLD && totalLength > MIN_AUDIO_LENGTH;
            const triggeredByMaxLength = totalLength > MAX_AUDIO_LENGTH;
            const shouldProcess = triggeredBySilence || triggeredByMaxLength;

            if (shouldProcess && totalLength > MIN_AUDIO_LENGTH) {
                const fullAudio = Buffer.concat(audioBuffer);
                const audioSec = (fullAudio.length / 32000).toFixed(2);
                const triggerReason = triggeredByMaxLength ? '⚠️MAX_LENGTH' : '✅SILENCE';
                this.logger.log(`[VAD] ${triggerReason} | 오디오: ${audioSec}초 (${fullAudio.length} bytes)`);

                const fullSamples = new Int16Array(fullAudio.buffer.slice(
                    fullAudio.byteOffset,
                    fullAudio.byteOffset + fullAudio.byteLength
                ));
                const fullRms = Math.sqrt(
                    fullSamples.reduce((sum, s) => sum + s * s, 0) / fullSamples.length
                );
                const fullDecibel = 20 * Math.log10(fullRms / 32768);

                audioBuffer = [];
                silenceCount = 0;
                voiceCount = 0;

                if (fullDecibel > MIN_DECIBEL_THRESHOLD - 5) {
                    // 봇 context 없으면 처리 스킵
                    if (!context) {
                        continue;
                    }

                    // 사용자별 STT 쿨다운 체크
                    const userLastSttTime = context.lastSttTimeByUser.get(userId) || 0;
                    if (Date.now() - userLastSttTime < STT_COOLDOWN_MS) {
                        continue;
                    }
                    context.lastSttTimeByUser.set(userId, Date.now());

                    this.processAndRespond(roomId, fullAudio, userId).catch(err => {
                        this.logger.error(`[처리 에러] ${err.message}`);
                    });
                }
            }
        }
    }

    /**
     * 음성 처리 메인 로직
     * STT → RAG 임베딩 → Intent 분석 → (LLM 교정) → 검색/응답 → TTS
     */
    private async processAndRespond(roomId: string, audioBuffer: Buffer, userId: string) {
        const context = this.activeRooms.get(roomId);
        if (!context) return;

        // ================================================
        // 1. STT (음성 → 텍스트) - 항상 수행 (isPublishing과 무관)
        // ================================================
        const sttStart = Date.now();
        let transcript: string;
        try {
            transcript = await this.sttService.transcribeFromBufferStream(audioBuffer, 'live-audio.pcm');
        } catch (err) {
            this.logger.error(`[STT 에러] ${err.message}`);
            return;
        }
        this.logger.log(`[1.STT] ${Date.now() - sttStart}ms - "${transcript}" (${userId})`);

        if (!transcript.trim()) {
            this.logger.log(`[스킵] 빈 STT 결과`);
            return;
        }

        // ★ RAG로 발언 전송 (비동기, 논블로킹 - 회의록/임베딩용)
        // 모든 참가자의 발화를 기록 (봇 응답 여부와 무관)
        this.sendToRagForEmbedding(roomId, transcript, userId);

        // ================================================
        // 2. 봇 응답 여부 체크 (여기서부터 isPublishing 보호)
        // ================================================
        if (context.isPublishing) {
            this.logger.log(`[스킵] 이미 응답 중 (STT/RAG는 완료됨)`);
            return;
        }

        // Vision 모드 중에는 음성 처리 스킵 (Vision TTS와 충돌 방지)
        if (context.isVisionMode) {
            this.logger.log(`[스킵] Vision 모드 진행 중`);
            return;
        }

        const RESPONSE_COOLDOWN_MS = 3000;
        if (context.lastResponseTime > 0 && Date.now() - context.lastResponseTime < RESPONSE_COOLDOWN_MS) {
            this.logger.log(`[스킵] 응답 쿨다운 (${(RESPONSE_COOLDOWN_MS - (Date.now() - context.lastResponseTime)) / 1000}초 남음)`);
            return;
        }

        const requestId = Date.now();
        // Vision 모드 중에는 currentRequestId 변경하지 않음 (Vision TTS가 스킵되는 것 방지)
        if (!context.isVisionMode) {
            context.currentRequestId = requestId;
        }
        const startTime = Date.now();

        this.logger.log(`\n========== [봇 응답 처리] ${userId} ==========`);

        try {
            context.isPublishing = true;

            // Intent 분석
            const intentForContext = this.intentClassifier.classify(transcript);

            // ★ 모드 상태 디버그 로그
            this.logger.debug(`[모드 상태] ideaMode=${context.ideaModeActive}`);

            // ★ 아이디어 모드일 때: 검색 없이 요약만 해서 포스트잇에 전송
            if (context.ideaModeActive) {
                this.logger.log(`[아이디어 모드] 처리 시작 - "${transcript.substring(0, 30)}..."`);
                await this.detectAndBroadcastIdea(roomId, context, transcript, userId);
                // 아이디어 모드에서는 일반 응답 스킵 (봇이 말 안 함)
                this.logger.log(`[아이디어 모드] 처리 완료`);
                return;
            }

            // ★ Flowchart 모드일 때: 현재 화면에 대해 답변 (컨텍스트 활용)
            if (context.flowchartModeActive && context.flowchartContext && intentForContext.isCallIntent) {
                this.logger.log(`[Flowchart 모드] 질문 처리 시작 - "${transcript.substring(0, 30)}..."`);

                // Flowchart 컨텍스트를 포함한 프롬프트 생성
                const flowchartContextStr = this.buildFlowchartContextPrompt(context.flowchartContext);

                context.botState = BotState.SPEAKING;

                // LLM에 flowchart 컨텍스트와 함께 질문 전달
                const response = await this.llmService.answerWithContext(
                    transcript,
                    flowchartContextStr,
                    '플로우차트'
                );

                await this.speakAndPublish(context, roomId, requestId, response);
                context.botState = BotState.ARMED;
                context.lastResponseTime = Date.now();
                this.logger.log(`[Flowchart 모드] 처리 완료`);
                return;
            }

            // ★ 일반 모드 진입 로그
            this.logger.log(`[일반 모드] 검색/응답 처리 시작`);

            // ================================================
            // 2. Intent 분석 (패턴 + 퍼지 매칭) ~5ms
            // ================================================
            const intentStart = Date.now();
            const intentAnalysis = intentForContext;  // 이미 위에서 분석함
            this.logger.log(`[2.Intent] ${Date.now() - intentStart}ms - call=${intentAnalysis.isCallIntent}, conf=${intentAnalysis.confidence.toFixed(2)}, cat=${intentAnalysis.category}, needsLlm=${intentAnalysis.needsLlmCorrection}`);

            // 짧은 텍스트 필터링
            const hasStopWord = this.STOP_WORDS.some(w =>
                intentAnalysis.normalizedText.toLowerCase().includes(w.toLowerCase())
            );
            if (transcript.trim().length <= 2 && !intentAnalysis.isCallIntent && !hasStopWord) {
                this.logger.log(`[스킵] 짧은 추임새`);
                return;
            }

            // ================================================
            // 3. 스톱워드 처리
            // ================================================
            if (context.botState !== BotState.SLEEP && hasStopWord) {
                this.logger.log(`[스톱워드] → SLEEP`);
                context.botState = BotState.SPEAKING;
                await this.speakAndPublish(context, roomId, requestId, "알겠습니다. 다시 불러주세요.");
                context.botState = BotState.SLEEP;
                context.activeUserId = null;
                context.lastResponseTime = Date.now();
                return;
            }

            // ================================================
            // 3.5. Vision Intent 처리 (화면 공유 분석)
            // ================================================
            this.logger.debug(`[Vision 체크] isCallIntent=${intentAnalysis.isCallIntent}, isVisionIntent=${intentAnalysis.isVisionIntent}, hasScreenShare=${context.hasActiveScreenShare}, isVisionMode=${context.isVisionMode}`);

            if (intentAnalysis.isCallIntent && intentAnalysis.isVisionIntent && context.hasActiveScreenShare) {
                this.logger.log(`[Vision Intent 감지] 화면 분석 모드로 전환`);
                const visionHandled = await this.processVisionIntent(
                    roomId,
                    intentAnalysis.normalizedText,
                    userId
                );
                if (visionHandled) {
                    // Vision 처리가 시작되면 여기서 리턴 (캡처 응답은 DataChannel로 받음)
                    this.logger.log(`[Vision] 캡처 요청 전송됨 - 응답 대기 중`);
                    context.lastSpeechTime = Date.now();
                    return;
                }
                // Vision 처리가 안되면 (화면 공유 없음, 이미 처리 중 등) 일반 플로우로 계속
                this.logger.log(`[Vision] 처리 불가 - 일반 응답으로 전환`);
            }

            // ================================================
            // 3.6. 보드 열기 Intent 처리 (아이디어)
            // ================================================
            if (intentAnalysis.isCallIntent && intentAnalysis.isIdeaBoardIntent) {
                this.logger.log(`[아이디어 보드 열기] Intent 감지`);

                // DataChannel로 보드 열기 메시지 전송
                const openMessage = { type: 'OPEN_IDEA_BOARD' };
                const encoder = new TextEncoder();
                await context.room.localParticipant.publishData(
                    encoder.encode(JSON.stringify(openMessage)),
                    { reliable: true }
                );

                // 음성 응답
                context.botState = BotState.SPEAKING;
                await this.speakAndPublish(context, roomId, requestId, "아이디어 보드를 열었습니다. 아이디어를 말씀해주세요!");
                context.botState = BotState.ARMED;
                context.lastResponseTime = Date.now();
                return;
            }

            // Flowchart 보드 열기 Intent 처리
            if (intentAnalysis.isCallIntent && intentAnalysis.isFlowchartIntent) {
                this.logger.log(`[Flowchart 보드 열기] Intent 감지 - 발화자: ${userId}`);

                const openTime = Date.now();
                context.flowchartInitiator = userId;
                context.flowchartModeActive = true;
                context.flowchartOpenTime = openTime;
                this.logger.log(`[Flowchart 보드] initiator 설정: ${userId}, openTime: ${openTime}`);

                // DataChannel로 보드 열기 메시지 전송
                const openMessage = { type: 'OPEN_FLOWCHART_BOARD', initiator: userId };
                const encoder = new TextEncoder();
                await context.room.localParticipant.publishData(
                    encoder.encode(JSON.stringify(openMessage)),
                    { reliable: true }
                );

                // 음성 응답
                context.botState = BotState.SPEAKING;
                await this.speakAndPublish(context, roomId, requestId, "플로우차트 보드를 열었습니다. CDR 문서를 불러와서 분석해보세요!");
                context.botState = BotState.ARMED;
                context.lastResponseTime = Date.now();
                return;
            }

            // ================================================
            // 4. 웨이크워드 판단 + LLM 교정 (필요시만!)
            // ================================================
            let shouldRespond = intentAnalysis.isCallIntent;
            let processedText = intentAnalysis.normalizedText;
            let searchKeyword = intentAnalysis.extractedKeyword;
            let searchType = intentAnalysis.searchType;
            let category = intentAnalysis.category;

            // 확실하지 않지만 가능성 있으면 LLM 교정
            if (!shouldRespond && intentAnalysis.needsLlmCorrection) {
                this.logger.log(`[3.LLM교정] 시작 (conf=${intentAnalysis.confidence.toFixed(2)})`);
                const correctionStart = Date.now();
                const voiceIntent = await this.llmService.processVoiceIntent(transcript, intentAnalysis);
                this.logger.log(`[3.LLM교정] ${Date.now() - correctionStart}ms - respond=${voiceIntent.shouldRespond}`);

                shouldRespond = voiceIntent.shouldRespond;
                processedText = voiceIntent.correctedText;
                searchKeyword = voiceIntent.searchKeyword;
                searchType = voiceIntent.searchType;
                category = voiceIntent.category;
            }

            // ================================================
            // 5. SLEEP 상태 처리
            // ================================================
            if (context.botState === BotState.SLEEP) {
                if (!shouldRespond) {
                    this.logger.log(`[SLEEP] 웨이크워드 없음 - 무시`);
                    return;
                }

                // 웨이크워드 감지 → ARMED 전환
                this.logger.log(`[웨이크워드] → ARMED`);
                context.botState = BotState.ARMED;
                context.activeUserId = userId;
                context.lastInteractionTime = Date.now();

                // 질문이 있는지 확인
                const hasQuestion = intentAnalysis.isQuestionIntent ||
                    intentAnalysis.hasCommandWord ||
                    intentAnalysis.hasRequestPattern ||
                    (searchKeyword && searchKeyword.length >= 2);

                // 웨이크워드만 있고 질문 없으면 안내 응답
                if (!hasQuestion) {
                    this.logger.log(`[웨이크워드만] 안내 응답`);
                    context.botState = BotState.SPEAKING;
                    await this.speakAndPublish(context, roomId, requestId, "네, 무엇을 도와드릴까요?");
                    context.botState = BotState.ARMED;
                    context.lastResponseTime = Date.now();
                    return;
                }

                // 질문이 있으면 아래 ARMED 블록에서 계속 처리!
            }

            // ================================================
            // 6. SPEAKING 상태: 무시
            // ================================================
            if (context.botState === BotState.SPEAKING) {
                this.logger.log(`[SPEAKING] 발화 중 - 무시`);
                return;
            }

            // ================================================
            // 7. ARMED 상태: 명령 처리
            // ================================================
            if (context.botState === BotState.ARMED) {
                // 활성 사용자 체크
                if (context.activeUserId && context.activeUserId !== userId) {
                    this.logger.log(`[스킵] ${userId}는 활성 사용자 아님`);
                    return;
                }

                // 웨이크워드/봇 호칭 없으면 무시 (SLEEP에서 전환된 경우는 shouldRespond=true)
                if (!shouldRespond && !intentAnalysis.isBotRelated) {
                    this.logger.log(`[스킵] 웨이크워드/호칭 없음`);
                    return;
                }

                // 질문/명령 체크
                if (!intentAnalysis.isQuestionIntent &&
                    !intentAnalysis.hasCommandWord &&
                    !intentAnalysis.hasRequestPattern &&
                    (!searchKeyword || searchKeyword.length < 2)) {
                    this.logger.log(`[스킵] 질문/명령 아님`);
                    return;
                }

                context.lastInteractionTime = Date.now();

                // ============================================
                // 8. 검색 키워드 준비
                // ============================================
                let finalSearchKeyword = searchKeyword;
                let finalCategory = category;

                if (!finalSearchKeyword || finalSearchKeyword.length < 2) {
                    this.logger.log(`[키워드 추출] buildSearchPlan 호출`);
                    const searchPlan = await this.llmService.buildSearchPlan(processedText);
                    finalSearchKeyword = searchPlan.query;
                    finalCategory = searchPlan.category || category;
                }

                this.logger.log(`[검색 준비] keyword="${finalSearchKeyword}", cat=${finalCategory}`);

                // ============================================
                // 9. LLM 호출 (생각중 응답 포함)
                // ============================================
                // 상황별 자연스러운 대기 멘트
                const getThinkingPhrase = (category: string | null): string => {
                    if (category === '날씨') {
                        return ['어 잠깐만요~', '날씨 볼게요~'][Math.floor(Math.random() * 2)];
                    }
                    if (['카페', '맛집', '술집', '분식', '치킨', '피자', '빵집', '디저트', '쇼핑'].includes(category || '')) {
                        return ['어디 좋을까... 잠깐만요', '음 찾아볼게요~', '어 잠깐요~'][Math.floor(Math.random() * 3)];
                    }
                    if (['뉴스', '주식', '스포츠'].includes(category || '')) {
                        return ['어 잠깐 볼게요~', '음...'][Math.floor(Math.random() * 2)];
                    }
                    if (category === '백과') {
                        return ['음 그거...', '어 잠깐만요~'][Math.floor(Math.random() * 2)];
                    }
                    // 기본
                    return ['음...', '어 잠깐요~', '잠깐만요~'][Math.floor(Math.random() * 3)];
                };

                const thinkingPhrase = getThinkingPhrase(finalCategory);
                let thinkingSpoken = false;
                let llmResolved = false;

                const llmStart = Date.now();
                const llmPromise = this.llmService.sendMessage(
                    processedText,
                    intentAnalysis.searchDomain,
                    roomId
                ).finally(() => { llmResolved = true; });

                // 700ms 후에도 응답 없으면 "생각중" 발화
                const thinkingTask = (async () => {
                    await this.sleep(700);
                    if (llmResolved || context.currentRequestId !== requestId) return;
                    this.logger.log(`[생각중] 응답 대기...`);
                    context.botState = BotState.SPEAKING;
                    thinkingSpoken = true;
                    await this.speakAndPublish(context, roomId, requestId, thinkingPhrase);
                    context.botState = BotState.ARMED;
                })();

                const llmResult = await llmPromise;
                await thinkingTask;

                this.logger.log(`[4.LLM] ${Date.now() - llmStart}ms - "${llmResult.text.substring(0, 50)}..."`);

                if (context.currentRequestId !== requestId) return;

                // thinking 발화 후 연결어 자연스럽게
                let finalResponse = llmResult.text;
                if (thinkingSpoken) {
                    const connectors = ['', '아 ', '어 '];  // 빈 문자열 = 그냥 바로 말함
                    const connector = connectors[Math.floor(Math.random() * connectors.length)];
                    finalResponse = `${connector}${llmResult.text.trim()}`;
                }

                // ============================================
                // 10. DataChannel 전송 (검색 결과)
                // ============================================
                if (llmResult.searchResults && llmResult.searchResults.length > 0) {
                    const primaryResult = llmResult.searchResults[0];
                    const routeInfo = await this.llmService.getRouteInfo(primaryResult);

                    const searchMessage = {
                        type: 'search_answer',
                        text: finalResponse,
                        category: finalCategory,
                        results: llmResult.searchResults,
                        route: routeInfo || undefined,
                    };

                    const encoder = new TextEncoder();
                    await context.room.localParticipant.publishData(
                        encoder.encode(JSON.stringify(searchMessage)),
                        { reliable: true }
                    );
                    this.logger.log(`[DataChannel] 검색 결과 전송 (${llmResult.searchResults.length}개)`);
                }

                // ============================================
                // 11. TTS 발화
                // ============================================
                context.shouldInterrupt = false;
                context.botState = BotState.SPEAKING;
                await this.speakAndPublish(context, roomId, requestId, finalResponse);

                // 응답 완료 → SLEEP
                context.botState = BotState.SLEEP;
                context.activeUserId = null;
                context.lastResponseTime = Date.now();

                this.logger.log(`========== [완료] 총 ${Date.now() - startTime}ms ==========\n`);
            }

        } catch (error) {
            this.logger.error(`[에러] ${error.message}`, error.stack);
            // 에러 시 안전하게 SLEEP 복귀
            context.botState = BotState.SLEEP;
            context.activeUserId = null;
        } finally {
            if (context.currentRequestId === requestId) {
                context.isPublishing = false;
            }
        }
    }

    private async publishAudio(roomId: string, audioSource: AudioSource, pcmBuffer: Buffer): Promise<void> {
        const SAMPLE_RATE = 16000;
        const FRAME_SIZE = 480;  // 30ms at 16kHz
        const BYTES_PER_SAMPLE = 2;
        const FRAME_BYTES = FRAME_SIZE * BYTES_PER_SAMPLE;
        const FRAME_DURATION_MS = 30;

        // 프레임 미리 준비 (버퍼링)
        const frames: AudioFrame[] = [];
        let offset = 0;
        while (offset < pcmBuffer.length) {
            const chunkEnd = Math.min(offset + FRAME_BYTES, pcmBuffer.length);
            const numSamples = Math.floor((chunkEnd - offset) / BYTES_PER_SAMPLE);

            const samples = new Int16Array(FRAME_SIZE);
            for (let j = 0; j < numSamples && j < FRAME_SIZE; j++) {
                samples[j] = pcmBuffer.readInt16LE(offset + j * BYTES_PER_SAMPLE);
            }

            frames.push(new AudioFrame(samples, SAMPLE_RATE, 1, FRAME_SIZE));
            offset += FRAME_BYTES;
        }

        // 일정한 간격으로 프레임 전송 (setInterval 사용)
        return new Promise((resolve) => {
            let frameIndex = 0;
            const startTime = Date.now();

            const sendFrame = () => {
                const context = this.activeRooms.get(roomId);
                if (context?.shouldInterrupt) {
                    this.logger.log(`[오디오 중단] Barge-in`);
                    context.shouldInterrupt = false;
                    resolve();
                    return;
                }

                if (frameIndex >= frames.length) {
                    resolve();
                    return;
                }

                // 프레임 전송 (논블로킹)
                audioSource.captureFrame(frames[frameIndex]).catch(() => {});
                frameIndex++;

                // 다음 프레임 스케줄 (드리프트 보정)
                if (frameIndex < frames.length) {
                    const expectedTime = frameIndex * FRAME_DURATION_MS;
                    const actualTime = Date.now() - startTime;
                    const nextDelay = Math.max(1, FRAME_DURATION_MS - (actualTime - expectedTime + FRAME_DURATION_MS));
                    setTimeout(sendFrame, nextDelay);
                } else {
                    resolve();
                }
            };

            // 첫 프레임 즉시 전송
            sendFrame();
        });
    }

    private sleep(ms: number): Promise<void> {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    private async speakAndPublish(
        context: RoomContext,
        roomId: string,
        requestId: number,
        message: string
    ): Promise<void> {
        const ttsStart = Date.now();
        const pcmAudio = await this.ttsService.synthesizePcm(message);
        this.logger.log(`[TTS] ${Date.now() - ttsStart}ms - ${pcmAudio.length} bytes`);

        context.speakingStartTime = Date.now();

        // Vision 요청은 requestId 체크 스킵 (별도 플로우)
        // 일반 음성 요청만 requestId 체크
        if (context.currentRequestId !== requestId && context.currentRequestId !== 0) {
            this.logger.warn(`[TTS 스킵] requestId 불일치: current=${context.currentRequestId}, expected=${requestId}`);
            return;
        }

        // TTS 합성 완료 후 interrupt 플래그 리셋 (합성 중 barge-in 무시)
        context.shouldInterrupt = false;

        await this.publishAudio(roomId, context.audioSource, pcmAudio);
    }

    private startArmedTimeoutChecker(roomId: string): void {
        const checkInterval = setInterval(() => {
            const context = this.activeRooms.get(roomId);
            if (!context) {
                clearInterval(checkInterval);
                return;
            }

            if (context.botState === BotState.ARMED) {
                const elapsed = Date.now() - context.lastInteractionTime;
                if (elapsed > this.ARMED_TIMEOUT_MS) {
                    this.logger.log(`[타임아웃] ARMED → SLEEP`);
                    context.botState = BotState.SLEEP;
                    context.activeUserId = null;
                }
            }
        }, 5000);
    }

    /**
     * 방 정리
     */
    private cleanupRoom(roomId: string): void {
        const context = this.activeRooms.get(roomId);
        if (context?.shutdownTimeout) {
            clearTimeout(context.shutdownTimeout);
        }
        this.activeRooms.delete(roomId);
    }

    async stopBot(roomId: string): Promise<void> {
        const context = this.activeRooms.get(roomId);
        if (context) {
            try {
                await this.ragClient.disconnect(roomId);
            } catch (error) {
                this.logger.error(`[RAG 해제 실패] ${error.message}`);
            }

            await context.room.disconnect();
            this.activeRooms.delete(roomId);
            this.logger.log(`[봇 종료] ${roomId}`);
        }
    }

    isActive(roomId: string): boolean {
        return this.activeRooms.has(roomId);
    }

    // =====================================================
    // Vision (화면 공유 분석) 관련 메서드
    // =====================================================

    /**
     * Vision 캡처 요청 전송 (Frontend로)
     */
    private async sendVisionCaptureRequest(
        roomId: string,
        requestId: number,
        userQuestion: string,
        userId: string
    ): Promise<void> {
        const context = this.activeRooms.get(roomId);
        if (!context) return;

        // 대기 중인 요청 저장
        context.pendingVisionRequest = {
            requestId,
            userQuestion,
            userId,
        };
        context.isVisionMode = true;

        // DataChannel로 캡처 요청 전송
        const captureRequest = {
            type: 'vision_capture_request',
            requestId,
            timestamp: Date.now(),
        };

        const encoder = new TextEncoder();
        await context.room.localParticipant.publishData(
            encoder.encode(JSON.stringify(captureRequest)),
            { reliable: true }
        );

        this.logger.log(`[Vision] 캡처 요청 전송 - requestId: ${requestId}`);
    }

    /**
     * Vision 캡처 응답 처리 (HTTP 엔드포인트에서 호출)
     */
    async handleVisionCaptureFromHttp(
        roomId: string,
        message: {
            type: string;
            requestId: number;
            imageBase64: string;
            cursorPosition?: { x: number; y: number };
            highlightedText?: string;
            screenWidth: number;
            screenHeight: number;
        }
    ): Promise<void> {
        this.logger.log(`[Vision HTTP] 처리 시작 - room: ${roomId}, requestId: ${message.requestId}`);
        await this.handleVisionCaptureResponse(roomId, message);
    }

    /**
     * Vision 캡처 응답 처리 (내부 메서드)
     */
    private async handleVisionCaptureResponse(
        roomId: string,
        message: {
            type: string;
            requestId: number;
            imageBase64: string;
            cursorPosition?: { x: number; y: number };
            highlightedText?: string;
            screenWidth: number;
            screenHeight: number;
        }
    ): Promise<void> {
        const context = this.activeRooms.get(roomId);
        if (!context || !context.pendingVisionRequest) {
            this.logger.warn(`[Vision] 대기 중인 요청 없음`);
            return;
        }

        const { requestId, userQuestion, userId } = context.pendingVisionRequest;

        // 요청 ID 확인
        if (message.requestId !== requestId) {
            this.logger.warn(`[Vision] 요청 ID 불일치: ${message.requestId} vs ${requestId}`);
            return;
        }

        // Vision 플로우용 락 획득 (음성 처리와 충돌 방지)
        if (this.processingLock.get(roomId)) {
            this.logger.warn(`[Vision] 다른 처리 진행 중 - 대기`);
            // 짧은 대기 후 재시도 (최대 2초)
            for (let i = 0; i < 20 && this.processingLock.get(roomId); i++) {
                await this.sleep(100);
            }
            if (this.processingLock.get(roomId)) {
                this.logger.error(`[Vision] 락 획득 실패 - 취소`);
                this.resetVisionState(context);
                return;
            }
        }
        this.processingLock.set(roomId, true);
        context.isPublishing = true;

        // Vision 플로우용 currentRequestId 설정 (TTS 발화를 위해 필수)
        context.currentRequestId = requestId;

        this.logger.log(`\n========== [Vision 캡처 응답 처리] ==========`);
        this.logger.log(`이미지 크기: ${(message.imageBase64.length / 1024).toFixed(1)}KB`);
        if (message.cursorPosition) {
            this.logger.log(`마우스 커서: (${message.cursorPosition.x}, ${message.cursorPosition.y})`);
        } else {
            this.logger.log(`마우스 커서: 없음`);
        }
        this.logger.log(`화면 크기: ${message.screenWidth}x${message.screenHeight}`);

        try {
            // 이미지 검증
            const validation = this.visionService.validateAndCompressImage(message.imageBase64);
            if (!validation.valid) {
                this.logger.error(`[Vision] 이미지 검증 실패: ${validation.error}`);
                await this.speakAndPublish(context, roomId, requestId, "화면을 캡처하는데 문제가 있어요. 다시 한번 말씀해주세요.");
                return;
            }

            // Vision API 호출
            const visionContext: VisionContext = {
                cursorPosition: message.cursorPosition,
                highlightedText: message.highlightedText,
                screenWidth: message.screenWidth,
                screenHeight: message.screenHeight,
            };

            context.botState = BotState.SPEAKING;
            context.speakingStartTime = Date.now();

            // "잠깐만요" 먼저 말하기 (Vision API 호출 시간 벌기)
            const thinkingPhrases = [
                '잠깐 볼게요~',
                '한번 볼게요',
                '잠깐만요~',
            ];
            const thinkingPhrase = thinkingPhrases[Math.floor(Math.random() * thinkingPhrases.length)];
            await this.speakAndPublish(context, roomId, requestId, thinkingPhrase);

            // Vision API 호출
            const result = await this.visionService.analyzeScreenShare(
                validation.compressed!,
                userQuestion,
                visionContext
            );

            this.logger.log(`[Vision] 분석 완료 - 타입: ${result.analysisType}`);

            // DataChannel로 Vision 결과 전송 (Frontend에서 아바타 복귀 등 처리)
            const visionResultMessage = {
                type: 'vision_result',
                requestId,
                analysisType: result.analysisType,
                text: result.text,
            };

            const encoder = new TextEncoder();
            await context.room.localParticipant.publishData(
                encoder.encode(JSON.stringify(visionResultMessage)),
                { reliable: true }
            );

            // TTS 발화
            await this.speakAndPublish(context, roomId, requestId, result.text);

            this.logger.log(`[Vision] 완료`);

        } catch (error) {
            this.logger.error(`[Vision] 처리 에러: ${error.message}`);
            try {
                await this.speakAndPublish(context, roomId, requestId, "화면 분석 중에 문제가 생겼어요. 다시 한번 해볼게요.");
            } catch (ttsError) {
                this.logger.error(`[Vision] 에러 TTS 실패: ${ttsError.message}`);
            }
        } finally {
            // 상태 정리 (항상 실행)
            this.resetVisionState(context);
            context.lastResponseTime = Date.now();
            context.lastSpeechTime = Date.now();
            context.isPublishing = false;
            this.processingLock.set(roomId, false);
            this.logger.log(`[Vision] 상태 정리 완료 - 음성 처리 재개 가능`);
        }
    }

    /**
     * Vision 상태 리셋 헬퍼
     */
    private resetVisionState(context: RoomContext): void {
        context.botState = BotState.SLEEP;
        context.isVisionMode = false;
        context.pendingVisionRequest = undefined;
    }

    /**
     * Vision Intent 감지 시 처리
     */
    async processVisionIntent(
        roomId: string,
        userQuestion: string,
        userId: string
    ): Promise<boolean> {
        const context = this.activeRooms.get(roomId);
        if (!context) return false;

        // 화면 공유 활성 여부 확인
        if (!context.hasActiveScreenShare) {
            this.logger.log(`[Vision] 화면 공유 없음 - 일반 응답으로 전환`);
            return false;
        }

        // 이미 Vision 처리 중이면 타임아웃 체크 (10초 이상 지났으면 리셋)
        if (context.isVisionMode && context.pendingVisionRequest) {
            const elapsed = Date.now() - context.pendingVisionRequest.requestId;
            if (elapsed < 10000) {
                this.logger.log(`[Vision] 이미 처리 중 (${(elapsed / 1000).toFixed(1)}초 경과) - 스킵`);
                return false;
            }
            // 10초 이상 응답 없으면 리셋하고 새로 시작
            this.logger.log(`[Vision] 이전 요청 타임아웃 (${(elapsed / 1000).toFixed(1)}초) - 리셋 후 재시도`);
            context.isVisionMode = false;
            context.pendingVisionRequest = undefined;
        }

        const requestId = Date.now();

        this.logger.log(`\n========== [Vision 요청] ==========`);
        this.logger.log(`질문: "${userQuestion}"`);

        // 캡처 요청 전송
        await this.sendVisionCaptureRequest(roomId, requestId, userQuestion, userId);

        return true;
    }

    // ============================================================
    // ============================================================
    // Flowchart 컨텍스트 프롬프트 생성
    // ============================================================

    private buildFlowchartContextPrompt(flowchartContext: {
        nodes: Array<{ id: string; content: string; nodeType: string; depth: number; branch: number }>;
        edges: Array<{ from: string; to: string; label?: string }>;
        summary: string;
    }): string {
        const { nodes, edges, summary } = flowchartContext;

        // 노드 타입별 분류
        const nodesByType: Record<string, string[]> = {
            start: [],
            end: [],
            process: [],
            decision: [],
            io: [],
        };

        nodes.forEach(node => {
            if (nodesByType[node.nodeType]) {
                nodesByType[node.nodeType].push(node.content);
            }
        });

        // 흐름 분석
        const flows: string[] = [];
        edges.forEach(edge => {
            const fromNode = nodes.find(n => n.id === edge.from);
            const toNode = nodes.find(n => n.id === edge.to);
            if (fromNode && toNode) {
                const label = edge.label ? ` (${edge.label})` : '';
                flows.push(`  "${fromNode.content}" → "${toNode.content}"${label}`);
            }
        });

        let contextStr = `=== 현재 플로우차트 화면 ===\n`;
        contextStr += `${summary}\n\n`;

        if (nodesByType.start.length > 0) {
            contextStr += `[시작점] ${nodesByType.start.join(', ')}\n`;
        }
        if (nodesByType.process.length > 0) {
            contextStr += `[처리 단계] ${nodesByType.process.join(', ')}\n`;
        }
        if (nodesByType.decision.length > 0) {
            contextStr += `[분기 조건] ${nodesByType.decision.join(', ')}\n`;
        }
        if (nodesByType.io.length > 0) {
            contextStr += `[입출력] ${nodesByType.io.join(', ')}\n`;
        }
        if (nodesByType.end.length > 0) {
            contextStr += `[종료점] ${nodesByType.end.join(', ')}\n`;
        }

        if (flows.length > 0) {
            contextStr += `\n[흐름]\n${flows.join('\n')}\n`;
        }

        return contextStr;
    }

    // ============================================================
    // RAG 임베딩 전송 (회의록용)
    // ============================================================

    /**
     * STT 결과를 RAG 서버로 전송 (임베딩용)
     * - 비동기, 논블로킹 (fire-and-forget)
     * - 짧은 추임새나 무의미한 텍스트는 필터링
     */
    private sendToRagForEmbedding(roomId: string, text: string, speaker: string): void {
        // 너무 짧은 텍스트 필터링 (3글자 이하)
        if (text.trim().length <= 3) {
            return;
        }

        // 추임새 단어 목록 (단독으로 쓰일 때만 의미 없는 단어들)
        const fillerWords = new Set([
            '음', '어', '아', '네', '응', '예', '오케이', '그래', '하하',
            '뭐', '에', '으', '아아', '어어', '음음', '으으', '에에',
            '네네', '응응', '예예', 'ㅋㅋ', 'ㅋㅋㅋ', '흠', '허', '헐'
        ]);

        // 공백/구두점으로 단어 분리
        const words = text.trim()
            .split(/[\s,.\?\!…]+/)
            .filter(w => w.length > 0);

        // 추임새가 아닌 단어가 있는지 체크
        const meaningfulWords = words.filter(word => !fillerWords.has(word.toLowerCase()));

        // 의미 있는 단어가 하나도 없으면 스킵
        if (meaningfulWords.length === 0) {
            this.logger.debug(`[RAG 임베딩 스킵] 추임새만 있음: "${text}"`);
            return;
        }

        // 의미 있는 단어가 있어도 총 글자수가 너무 적으면 스킵
        const meaningfulText = meaningfulWords.join('');
        if (meaningfulText.length <= 2) {
            this.logger.debug(`[RAG 임베딩 스킵] 의미 있는 내용 부족: "${text}"`);
            return;
        }

        // 비동기로 RAG에 전송 (응답 대기 없음)
        this.ragClient.sendStatement(roomId, text, speaker)
            .then(() => {
                this.logger.debug(`[RAG 임베딩] 전송 완료: "${text.substring(0, 30)}..." by ${speaker}`);
            })
            .catch(err => {
                this.logger.warn(`[RAG 임베딩 실패] ${err.message}`);
            });
    }

    // ============================================================
    // 시연용 목업 데이터 메서드
    // ============================================================

    /**
     * 이전 회의 컨텍스트 설정 (시연용)
     * AURA가 "지난 회의 브리핑해줘" 등에 응답할 때 사용
     */
    setPreviousMeetingContext(roomId: string, context: {
        meetingTitle: string;
        summary: string;
        keyDecisions: string[];
        actionItems: string[];
        date: string;
    }): { success: boolean } {
        const roomContext = this.activeRooms.get(roomId);
        if (!roomContext) {
            this.logger.warn(`[이전 회의 컨텍스트] 방을 찾을 수 없음: ${roomId}`);
            return { success: false };
        }

        roomContext.previousMeetingContext = context;
        this.logger.log(`\n========== [이전 회의 컨텍스트 설정] ==========`);
        this.logger.log(`Room ID: ${roomId}`);
        this.logger.log(`회의 제목: ${context.meetingTitle}`);
        this.logger.log(`날짜: ${context.date}`);
        this.logger.log(`요약: ${context.summary.substring(0, 100)}...`);
        this.logger.log(`주요 결정사항: ${context.keyDecisions.length}개`);
        this.logger.log(`액션 아이템: ${context.actionItems.length}개`);

        return { success: true };
    }

    /**
     * 이전 회의 컨텍스트 조회
     */
    getPreviousMeetingContext(roomId: string): {
        meetingTitle: string;
        summary: string;
        keyDecisions: string[];
        actionItems: string[];
        date: string;
    } | null {
        const roomContext = this.activeRooms.get(roomId);
        return roomContext?.previousMeetingContext || null;
    }

    /**
     * 이전 회의 브리핑 텍스트 생성
     */
    formatPreviousMeetingBriefing(roomId: string): string {
        const ctx = this.getPreviousMeetingContext(roomId);
        if (!ctx) {
            return '이전 회의 정보가 없습니다.';
        }

        let briefing = `지난 ${ctx.date}에 진행한 "${ctx.meetingTitle}" 회의 내용을 브리핑 드리겠습니다.\n\n`;
        briefing += `${ctx.summary}\n\n`;

        if (ctx.keyDecisions.length > 0) {
            briefing += `주요 결정사항:\n`;
            ctx.keyDecisions.forEach((decision, i) => {
                briefing += `${i + 1}. ${decision}\n`;
            });
            briefing += '\n';
        }

        if (ctx.actionItems.length > 0) {
            briefing += `액션 아이템:\n`;
            ctx.actionItems.forEach((item, i) => {
                briefing += `${i + 1}. ${item}\n`;
            });
        }

        return briefing;
    }

    /**
     * 활성 방 목록 조회 (디버깅용)
     */
    getActiveRoomIds(): string[] {
        return Array.from(this.activeRooms.keys());
    }
}