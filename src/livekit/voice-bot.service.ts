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

// DDD Event Storming 타입
type DDDElementType = 'event' | 'command' | 'actor' | 'policy' | 'readModel' | 'external' | 'aggregate';

interface DDDElement {
    type: DDDElementType;
    content: string;
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
    // 이벤트 스토밍 모드
    eventStormModeActive: boolean;
    eventStormInitiator: string | null;  // 보드를 연 사람 (이 사람만 닫을 수 있음)
    eventStormOpenTime: number;   // 보드가 열린 시간 (grace period용)
    lastEventStormStart: number;  // START 전용 디바운싱
    lastEventStormEnd: number;    // END 전용 디바운싱
    // DDD 처리 상태 (중복 방지)
    isDddProcessing: boolean;
    lastDddText: string;
    shutdownTimeout?: NodeJS.Timeout;
}

@Injectable()
export class VoiceBotService {
    private readonly logger = new Logger(VoiceBotService.name);
    private activeRooms: Map<string, RoomContext> = new Map();
    private processingLock: Map<string, boolean> = new Map();

    private readonly STOP_WORDS = ['멈춰', '그만', '스톱', '중지'];
    private readonly ARMED_TIMEOUT_MS = 30000;

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
                } else if (message.type === 'EVENT_STORM_START') {
                    const senderId = participant?.identity || 'unknown';
                    // 이미 ON이면 무시 (음성 명령으로 먼저 열렸을 수 있음)
                    if (context.eventStormModeActive) {
                        this.logger.debug(`[모드 변경] 이벤트스토밍 START 무시 - 이미 ON (initiator=${context.eventStormInitiator}, 요청자=${senderId})`);
                        return;
                    }
                    // START끼리만 디바운싱 (END 후 즉시 START는 허용)
                    if (now - context.lastEventStormStart < MODE_CHANGE_DEBOUNCE_MS) {
                        this.logger.debug(`[모드 변경] 이벤트스토밍 START 무시 (디바운싱)`);
                        return;
                    }
                    context.eventStormModeActive = true;
                    context.eventStormInitiator = senderId;  // 발화자 기록
                    context.lastEventStormStart = now;
                    this.logger.log(`[모드 변경] 이벤트 스토밍 ON by ${senderId} (initiator 설정)`);
                } else if (message.type === 'EVENT_STORM_END') {
                    const senderId = participant?.identity || 'unknown';
                    // 이미 OFF면 무시
                    if (!context.eventStormModeActive) {
                        this.logger.debug(`[모드 변경] 이벤트스토밍 END 무시 (이미 OFF)`);
                        return;
                    }
                    // ★ Grace period: 보드 열린 직후 1초 이내의 END는 무시 (React useEffect cleanup 문제 방지)
                    const OPEN_GRACE_PERIOD_MS = 1000;
                    if (context.eventStormOpenTime > 0 && now - context.eventStormOpenTime < OPEN_GRACE_PERIOD_MS) {
                        this.logger.debug(`[모드 변경] 이벤트스토밍 END 무시 (grace period: ${now - context.eventStormOpenTime}ms < ${OPEN_GRACE_PERIOD_MS}ms)`);
                        return;
                    }
                    // 발화자(initiator)만 닫을 수 있음
                    if (context.eventStormInitiator && context.eventStormInitiator !== senderId) {
                        this.logger.debug(`[모드 변경] 이벤트스토밍 END 무시 (발화자 아님: ${senderId} != ${context.eventStormInitiator})`);
                        return;
                    }
                    // END끼리만 디바운싱 (START 후 즉시 END는 허용)
                    if (now - context.lastEventStormEnd < MODE_CHANGE_DEBOUNCE_MS) {
                        this.logger.debug(`[모드 변경] 이벤트스토밍 END 무시 (디바운싱)`);
                        return;
                    }
                    context.eventStormModeActive = false;
                    context.eventStormInitiator = null;  // 초기화
                    context.eventStormOpenTime = 0;      // 초기화
                    context.lastEventStormEnd = now;
                    this.logger.log(`[모드 변경] 이벤트 스토밍 OFF by ${senderId}`);
                } else if (message.type === 'DDD_SUGGEST_REQUEST') {
                    // DDD AI 제안 요청
                    this.logger.log(`[DDD 제안] 요청 수신 - 요소 수: ${message.boardState?.length || 0}`);
                    this.handleDddSuggestRequest(roomId, message.boardState || []);
                } else if (message.type === 'DDD_SUMMARY_REQUEST') {
                    // DDD 요약 요청
                    this.logger.log(`[DDD 요약] 요청 수신 - 요소: ${message.boardState?.length || 0}, 컨텍스트: ${message.contexts?.length || 0}`);
                    this.handleDddSummaryRequest(roomId, message.boardState || [], message.contexts || []);
                } else if (message.type === 'DDD_CODE_REQUEST') {
                    // DDD 코드 생성 요청
                    this.logger.log(`[DDD 코드] 요청 수신 - 요소: ${message.boardState?.length || 0}, 언어: ${message.language || 'python'}`);
                    this.handleDddCodeRequest(roomId, message.boardState || [], message.contexts || [], message.language || 'python', message.requesterId);
                }
            } catch (error) {
                // JSON 파싱 실패는 무시 (다른 메시지일 수 있음)
            }
        });

        try {
            await room.connect(livekitUrl, botToken);

            try {
                await this.ragClient.connect(roomId);
                this.logger.log(`[RAG 연결 완료]`);
            } catch (error) {
                this.logger.error(`[RAG 연결 실패] ${error.message}`);
            }

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
    // 이벤트 스토밍 분석 (DDD)
    // =====================================================

    /**
     * 발화를 DDD 요소로 분석하고 DataChannel로 전송
     * - 최소 필터만 적용 (짧은 발화, 추임새만 스킵)
     * - 나머지는 모두 LLM에게 분석 요청
     */
    private async analyzeAndBroadcastDDD(
        roomId: string,
        context: RoomContext,
        transcript: string,
        userId: string
    ): Promise<void> {
        // 너무 짧은 발화는 스킵 (5글자 이하)
        if (transcript.length <= 5) {
            this.logger.log(`[DDD] 스킵 - 너무 짧음: "${transcript}"`);
            return;
        }

        // 단순 인사/추임새 필터링 (최소한만)
        const skipPatterns = /^(안녕|네|응|어|음|아|예|오케이|ㅇㅇ|ㅋ+|하하|그래|알겠|뭐지|뭐야|아아|으으|에에)[\.\?\!]?$/i;
        if (skipPatterns.test(transcript.trim())) {
            this.logger.log(`[DDD] 스킵 - 추임새: "${transcript}"`);
            return;
        }

        try {
            // LLM에게 DDD 요소 분석 요청
            const elements = await this.extractDDDElements(transcript);

            if (!elements || elements.length === 0) {
                return;  // 의미 있는 DDD 요소가 없으면 스킵
            }

            this.logger.log(`[DDD 분석] ${elements.length}개 요소 추출`);

            // 각 요소를 DataChannel로 브로드캐스트 (비동기, 논블로킹)
            const encoder = new TextEncoder();
            for (let i = 0; i < elements.length; i++) {
                const element = elements[i];
                const dddMessage = {
                    type: 'DDD_ELEMENT',
                    element: {
                        id: `ddd-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
                        content: element.content,
                        dddType: element.type,
                    },
                };

                // 비동기 전송 (await 없이 fire-and-forget)
                context.room.localParticipant.publishData(
                    encoder.encode(JSON.stringify(dddMessage)),
                    { reliable: false }  // 빠른 전송 (UDP-like)
                ).catch(err => this.logger.warn(`[DDD 전송 실패] ${err.message}`));

                this.logger.log(`[DDD 전송] ${element.type}: "${element.content}"`);

                // 요소 간 짧은 딜레이 (애니메이션 위해, 마지막은 스킵)
                if (i < elements.length - 1) {
                    await this.sleep(150);
                }
            }
        } catch (error) {
            this.logger.error(`[DDD 분석 에러] ${error.message}`);
        }
    }

    /**
     * LLM이 발화에서 DDD 요소 추출 (간소화된 프롬프트)
     */
    private async extractDDDElements(transcript: string): Promise<DDDElement[]> {
        const prompt = `DDD Event Storming 요소 추출. 발화: "${transcript}"

타입: event(이벤트), command(명령), actor(행위자), policy(정책), aggregate(집합체), external(외부), readModel(조회)

규칙: 10자 이내, 도메인 관련만, 없으면 []

예: "고객이 주문하면 재고 감소" → [{"type":"actor","content":"고객"},{"type":"command","content":"주문"},{"type":"event","content":"재고 감소됨"}]

JSON 배열만 출력:`;

        try {
            // 순수 LLM 호출 (검색 없이, 짧은 응답)
            this.logger.debug(`[DDD LLM] 순수 LLM 호출 시작`);
            const answer = await this.llmService.sendMessagePure(prompt, 200);
            this.logger.debug(`[DDD LLM] 응답: ${answer.substring(0, 100)}...`);

            // JSON 파싱 시도
            const jsonMatch = answer.match(/\[[\s\S]*\]/);
            if (!jsonMatch) {
                this.logger.debug(`[DDD LLM] JSON 패턴 없음`);
                return [];
            }

            let jsonStr = jsonMatch[0];

            // JSON 복구: 여러 패턴 처리
            // 패턴 1: [{"type":"x"}],[{"type":"y"}] → [{"type":"x"},{"type":"y"}]
            if (jsonStr.includes('],[')) {
                this.logger.warn(`[DDD LLM] 배열 분리 감지, 병합 시도`);
                jsonStr = jsonStr.replace(/\],\s*\[/g, ',');
            }

            // 패턴 2: ["type":"x","content":"y"] → [{"type":"x","content":"y"}] (중괄호 누락)
            if (jsonStr.match(/\[\s*"type"\s*:/) && !jsonStr.match(/\[\s*\{/)) {
                this.logger.warn(`[DDD LLM] 중괄호 누락 감지, 복구 시도`);
                jsonStr = jsonStr
                    .replace(/\[\s*"/g, '[{"')  // 시작
                    .replace(/,\s*"type"/g, ',{"type"')   // 중간 요소들
                    .replace(/"content"\s*:\s*"([^"]+)"\s*,\s*\{/g, '"content":"$1"},{"')  // 다음 요소 앞
                    .replace(/"content"\s*:\s*"([^"]+)"\s*\]/g, '"content":"$1"}]'); // 마지막
            }

            // 패턴 3: 객체 사이 쉼표 누락 [{"type":"a"}{"type":"b"}]
            jsonStr = jsonStr.replace(/\}\s*\{/g, '},{');

            // 패턴 4: 불완전한 객체 닫기 처리
            jsonStr = jsonStr.replace(/"content"\s*:\s*"([^"]+)"\s*,\s*"type"/g, '"content":"$1"},{"type"');

            this.logger.debug(`[DDD LLM] 처리된 JSON: ${jsonStr.substring(0, 100)}...`);

            const elements: DDDElement[] = JSON.parse(jsonStr);

            // 유효성 검사
            const validTypes = ['event', 'command', 'actor', 'policy', 'readModel', 'external', 'aggregate'];
            return elements.filter(e =>
                e && typeof e === 'object' &&
                validTypes.includes(e.type) &&
                e.content &&
                typeof e.content === 'string' &&
                e.content.length >= 2 &&
                e.content.length <= 20
            );
        } catch (error) {
            this.logger.error(`[DDD 추출 실패] ${error.message}`);
            return [];
        }
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

        const SILENCE_THRESHOLD = 50;  // 35→30 (더 빠른 발화 감지)
        const MIN_AUDIO_LENGTH = 16000;  // 최소 1초
        const MAX_AUDIO_LENGTH = 64000;  // 최대 4초 (긴 발화 중간에 끊기)
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
            const shouldProcess =
                (silenceCount > SILENCE_THRESHOLD && totalLength > MIN_AUDIO_LENGTH) ||  // 발화 종료
                (totalLength > MAX_AUDIO_LENGTH);  // 최대 버퍼 도달 (긴 발화 중간 처리)

            if (shouldProcess && totalLength > MIN_AUDIO_LENGTH) {
                const fullAudio = Buffer.concat(audioBuffer);

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
            this.logger.debug(`[모드 상태] ideaMode=${context.ideaModeActive}, eventStormMode=${context.eventStormModeActive}`);

            // ★ 아이디어 모드일 때: 검색 없이 요약만 해서 포스트잇에 전송
            if (context.ideaModeActive) {
                this.logger.log(`[아이디어 모드] 처리 시작 - "${transcript.substring(0, 30)}..."`);
                await this.detectAndBroadcastIdea(roomId, context, transcript, userId);
                // 아이디어 모드에서는 일반 응답 스킵 (봇이 말 안 함)
                this.logger.log(`[아이디어 모드] 처리 완료`);
                return;
            }

            // ★ 이벤트 스토밍 모드일 때: DDD 요소 분석 및 전송
            if (context.eventStormModeActive) {
                // 중복 처리 방지: 이미 처리 중이면 스킵
                if (context.isDddProcessing) {
                    this.logger.debug(`[DDD] 이미 처리 중 - 스킵`);
                    return;
                }

                // 같은 텍스트 중복 처리 방지 (STT가 같은 발화를 여러 번 인식하는 경우)
                if (context.lastDddText === transcript) {
                    this.logger.debug(`[DDD] 중복 텍스트 - 스킵: "${transcript.substring(0, 20)}..."`);
                    return;
                }

                context.isDddProcessing = true;
                context.lastDddText = transcript;

                try {
                    this.logger.log(`[DDD 모드] 처리 시작 - "${transcript.substring(0, 30)}..."`);
                    await this.analyzeAndBroadcastDDD(roomId, context, transcript, userId);
                    this.logger.log(`[DDD 모드] 처리 완료`);
                } finally {
                    context.isDddProcessing = false;
                }
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
            // 3.6. 보드 열기 Intent 처리 (아이디어/DDD)
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

            if (intentAnalysis.isCallIntent && intentAnalysis.isDddBoardIntent) {
                this.logger.log(`[DDD 보드 열기] Intent 감지 - 발화자: ${userId}`);

                // ★ 발화자를 initiator로 미리 설정 (프론트엔드 메시지 도착 전에!)
                const openTime = Date.now();
                context.eventStormInitiator = userId;
                context.eventStormModeActive = true;
                context.eventStormOpenTime = openTime;  // grace period용
                context.lastEventStormStart = openTime;
                this.logger.log(`[DDD 보드] initiator 설정: ${userId}, openTime: ${openTime}`);

                // DataChannel로 보드 열기 메시지 전송 (발화자 정보 포함)
                const openMessage = { type: 'OPEN_DDD_BOARD', initiator: userId };
                const encoder = new TextEncoder();
                await context.room.localParticipant.publishData(
                    encoder.encode(JSON.stringify(openMessage)),
                    { reliable: true }
                );

                // 음성 응답
                context.botState = BotState.SPEAKING;
                await this.speakAndPublish(context, roomId, requestId, "이벤트 스토밍 보드를 열었습니다. 도메인 이벤트를 말씀해주세요!");
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
                '어 잠깐 볼게요~',
                '음 한번 볼게요',
                '아 잠깐만요~',
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
    // DDD Event Storming AI 제안
    // ============================================================

    private async handleDddSuggestRequest(
        roomId: string,
        boardState: Array<{ type: string; content: string; connections: string[] }>
    ): Promise<void> {
        const context = this.activeRooms.get(roomId);
        if (!context) return;

        try {
            const boardSummary = this.summarizeDddBoard(boardState);
            const prompt = `DDD Event Storming 보드 분석. 다음에 추가할 요소 3개 제안.

현재 보드:
${boardSummary}

타입: event(이벤트), command(명령), actor(행위자), policy(정책), readModel(조회), external(외부), aggregate(집합체)

JSON 형식으로만 응답:
{"suggestions":[{"content":"내용","type":"타입","reason":"이유"}]}`;

            const response = await this.llmService.sendMessagePure(prompt, 800);
            let suggestions = [];
            const jsonMatch = response.match(/\{[\s\S]*\}/);
            if (jsonMatch) {
                try {
                    const parsed = JSON.parse(jsonMatch[0]);
                    suggestions = (parsed.suggestions || []).slice(0, 3);
                } catch { suggestions = []; }
            }

            const encoder = new TextEncoder();
            await context.room.localParticipant.publishData(
                encoder.encode(JSON.stringify({ type: 'DDD_SUGGEST_RESPONSE', suggestions })),
                { reliable: true }
            );
        } catch (error) {
            this.logger.error(`[DDD 제안] 에러: ${error.message}`);
        }
    }

    // ============================================================
    // DDD Event Storming 요약
    // ============================================================

    private async handleDddSummaryRequest(
        roomId: string,
        boardState: Array<{ type: string; content: string; connections: string[]; id?: string }>,
        contexts: Array<{ id: string; name: string; noteIds: string[] }>
    ): Promise<void> {
        const context = this.activeRooms.get(roomId);
        if (!context) return;

        try {
            const boardSummary = this.summarizeDddBoardDetailed(boardState, contexts);
            const prompt = `DDD Event Storming 결과 요약. JSON으로만 응답.

보드 상태:
${boardSummary}

응답 형식:
{"overview":"도메인 개요","businessFlow":"비즈니스 흐름","contexts":[{"name":"이름","responsibility":"책임","elements":["요소"]}],"contextRelations":[{"from":"A","to":"B","relation":"관계"}],"architecture":"아키텍처 제안","improvements":["개선점"]}`;

            const response = await this.llmService.sendMessagePure(prompt, 1500);
            let summary = null;
            const jsonMatch = response.match(/\{[\s\S]*\}/);
            if (jsonMatch) {
                try { summary = JSON.parse(jsonMatch[0]); } catch { summary = null; }
            }

            const encoder = new TextEncoder();
            await context.room.localParticipant.publishData(
                encoder.encode(JSON.stringify({ type: 'DDD_SUMMARY_RESPONSE', summary })),
                { reliable: true }
            );
        } catch (error) {
            this.logger.error(`[DDD 요약] 에러: ${error.message}`);
        }
    }

    // ============================================================
    // DDD 코드 생성
    // ============================================================

    private async handleDddCodeRequest(
        roomId: string,
        boardState: Array<{ type: string; content: string; connections: string[]; id?: string }>,
        contexts: Array<{ id: string; name: string; noteIds: string[] }>,
        language: string,
        requesterId?: string
    ): Promise<void> {
        const context = this.activeRooms.get(roomId);
        if (!context) return;

        try {
            const boardSummary = this.summarizeDddBoardCompact(boardState, contexts);

            const langSpec = {
                python: 'Python (dataclass, 타입힌트)',
                typescript: 'TypeScript (interface, class)',
                java: 'Java (record/class)'
            };

            // 간결한 프롬프트 - 코드만 출력
            const prompt = `DDD Event Storming을 ${langSpec[language] || langSpec.python} 코드로 변환하세요.

보드 상태: ${boardSummary}

규칙:
- Aggregate=class (상태+메서드)
- Event=dataclass
- Command=Aggregate 메서드
- Policy=이벤트 핸들러

코드만 출력하세요. 설명이나 JSON 래퍼 없이 순수 코드만.`;

            this.logger.log(`[DDD 코드] LLM 호출 시작 - 언어: ${language}`);
            const response = await this.llmService.sendMessagePure(prompt, 1500);
            this.logger.log(`[DDD 코드] LLM 응답 수신: ${response.substring(0, 100)}...`);

            let code = '';
            let explanation = '';

            // 1. JSON 형식으로 응답한 경우 파싱 시도
            const jsonMatch = response.match(/\{[\s\S]*"code"\s*:\s*"[\s\S]*"\s*\}/);
            if (jsonMatch) {
                try {
                    const parsed = JSON.parse(jsonMatch[0]);
                    if (parsed.code) {
                        code = parsed.code;
                        explanation = parsed.explanation || '';
                        this.logger.log(`[DDD 코드] JSON 파싱 성공`);
                    }
                } catch (e) {
                    this.logger.log(`[DDD 코드] JSON 파싱 실패, 다른 방법 시도`);
                }
            }

            // 2. 코드 블록 추출 시도 (```python ... ```)
            if (!code) {
                const codeBlockMatch = response.match(/```(?:python|typescript|java|ts|py)?\s*\n?([\s\S]*?)```/);
                if (codeBlockMatch) {
                    code = codeBlockMatch[1].trim();
                    this.logger.log(`[DDD 코드] 코드 블록 추출 성공`);
                }
            }

            // 3. 그래도 없으면 JSON 내부 code 필드 수동 추출
            if (!code) {
                const codeFieldMatch = response.match(/"code"\s*:\s*"([\s\S]*?)(?:"\s*,|\"\s*\})/);
                if (codeFieldMatch) {
                    code = codeFieldMatch[1]
                        .replace(/\\n/g, '\n')
                        .replace(/\\"/g, '"')
                        .replace(/\\t/g, '\t')
                        .replace(/\\\\/g, '\\');
                    this.logger.log(`[DDD 코드] code 필드 수동 추출 성공`);
                }
            }

            // 4. 최후의 수단: 전체 응답 정리
            if (!code) {
                code = response
                    .replace(/^```[\w]*\n?/, '')
                    .replace(/```$/, '')
                    .trim();
                this.logger.log(`[DDD 코드] 전체 응답 사용`);
            }

            // 간단한 설명 생성 (없으면)
            const elementCount = boardState.length;
            if (!explanation) {
                explanation = `${elementCount}개의 DDD 요소를 기반으로 ${language} 코드를 생성했습니다.`;
            }

            const responseMessage = {
                type: 'DDD_CODE_RESPONSE',
                code,
                explanation,
                language,
                requesterId,
            };

            const encoder = new TextEncoder();
            await context.room.localParticipant.publishData(
                encoder.encode(JSON.stringify(responseMessage)),
                { reliable: true }
            );

            this.logger.log(`[DDD 코드] 응답 전송 완료 - ${code.length}자`);
        } catch (error) {
            this.logger.error(`[DDD 코드] 에러: ${error.message}`);

            const encoder = new TextEncoder();
            await context.room.localParticipant.publishData(
                encoder.encode(JSON.stringify({
                    type: 'DDD_CODE_RESPONSE',
                    code: `# 코드 생성 실패: ${error.message}`,
                    explanation: '오류가 발생했습니다. 다시 시도해주세요.',
                    language,
                    requesterId,
                })),
                { reliable: true }
            );
        }
    }

    // ============================================================
    // DDD 헬퍼 메서드
    // ============================================================

    // 코드 생성용 간결한 요약 (latency 개선)
    private summarizeDddBoardCompact(
        boardState: Array<{ type: string; content: string; connections?: string[]; id?: string }>,
        contexts: Array<{ id: string; name: string; noteIds: string[] }>
    ): string {
        const parts: string[] = [];

        // 요소를 타입별로 그룹핑 (간결하게)
        const grouped: Record<string, string[]> = {};
        boardState.forEach(e => {
            if (!grouped[e.type]) grouped[e.type] = [];
            grouped[e.type].push(e.content);
        });

        Object.entries(grouped).forEach(([type, items]) => {
            parts.push(`${type}:[${items.join(',')}]`);
        });

        // 연결 관계 (핵심만)
        const conns: string[] = [];
        boardState.forEach(e => {
            e.connections?.slice(0, 3).forEach(targetId => {
                const target = boardState.find(t => t.id === targetId);
                if (target) conns.push(`${e.content}→${target.content}`);
            });
        });
        if (conns.length > 0) {
            parts.push(`flow:[${conns.slice(0, 10).join(',')}]`);
        }

        // 컨텍스트 (있으면)
        if (contexts.length > 0) {
            const ctxParts = contexts.map(ctx => {
                const els = boardState.filter(e => ctx.noteIds.includes(e.id || '')).map(e => e.content);
                return `${ctx.name}:{${els.join(',')}}`;
            });
            parts.push(`ctx:[${ctxParts.join(';')}]`);
        }

        return parts.join(' | ');
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

    private summarizeDddBoard(boardState: Array<{ type: string; content: string }>): string {
        const grouped: Record<string, string[]> = {};
        boardState.forEach(e => {
            if (!grouped[e.type]) grouped[e.type] = [];
            grouped[e.type].push(e.content);
        });
        return Object.entries(grouped).map(([type, items]) => `${type}: ${items.join(', ')}`).join('\n');
    }

    private summarizeDddBoardDetailed(
        boardState: Array<{ type: string; content: string; connections: string[]; id?: string }>,
        contexts: Array<{ id: string; name: string; noteIds: string[] }>
    ): string {
        const lines: string[] = [];

        // 요소별 그룹핑
        const grouped: Record<string, string[]> = {};
        boardState.forEach(e => {
            if (!grouped[e.type]) grouped[e.type] = [];
            grouped[e.type].push(e.content);
        });

        lines.push('### 요소:');
        Object.entries(grouped).forEach(([type, items]) => {
            lines.push(`- ${type}: ${items.join(', ')}`);
        });

        // 연결 관계
        const connections: string[] = [];
        boardState.forEach(e => {
            e.connections?.forEach(targetId => {
                const target = boardState.find(t => t.id === targetId);
                if (target) connections.push(`${e.content} → ${target.content}`);
            });
        });
        if (connections.length > 0) {
            lines.push('\n### 연결:');
            connections.forEach(c => lines.push(`- ${c}`));
        }

        // 컨텍스트
        if (contexts.length > 0) {
            lines.push('\n### Bounded Contexts:');
            contexts.forEach(ctx => {
                const elements = boardState.filter(e => ctx.noteIds.includes(e.id || ''));
                lines.push(`- ${ctx.name}: ${elements.map(e => e.content).join(', ')}`);
            });
        }

        return lines.join('\n');
    }
}