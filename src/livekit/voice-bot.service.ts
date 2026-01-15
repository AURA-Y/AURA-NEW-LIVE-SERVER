import { Injectable, Logger, Inject, forwardRef } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as fs from 'fs';
import * as path from 'path';
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
import { AgentRouterService } from '../agent/agent-router.service';
import { OpinionService } from '../agent/evidence';
import { PerplexityService, PerplexityMessage } from '../perplexity';
import { CalendarService } from '../calendar/calendar.service';
import type { LivekitService } from './livekit.service';

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
    speaker?: string;  // 발화자 ID (user인 경우)
}

// 참여자 발언 통계 타입
interface ParticipantSpeakingStats {
    participantId: string;
    participantName: string;
    speakingDurationMs: number;  // 총 발언 시간 (밀리초)
    speakingCount: number;       // 발언 횟수
    lastSpokenAt: number;        // 마지막 발언 시간
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
    // Event Storm 모드
    eventStormModeActive: boolean;
    eventStormInitiator: string | null;
    eventStormOpenTime: number;
    lastEventStormStart: number;
    lastEventStormEnd: number;
    isDddProcessing: boolean;
    lastDddText: string;
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
    // 설계 보드 모드 (다이어그램 관련 응답만 허용)
    designModeActive: boolean;
    designModeOpenTime: number;
    pendingDiagramExplanation?: {
        types: string[];
        mermaidCodes: Record<string, string>;
    };

    // 시연용 이전 회의 컨텍스트
    previousMeetingContext?: {
        meetingTitle: string;
        summary: string;
        keyDecisions: string[];
        actionItems: string[];
        date: string;
    };

    // 클라이언트 준비 대기 (인삿말 타이밍 제어)
    greetingDone: boolean;

    // AI 음소거 (사용자가 AI 음성을 음소거)
    aiMuted: boolean;
    // Perplexity 모드 (WFC 기반 흐름 제어)
    perplexityModeActive: boolean;
    // 호스트 전용 코칭 모드 (TTS 비활성화, Wake word 비활성화)
    hostOnlyMode: boolean;
    hostIdentity: string | null;
    // Wake word 활성화 여부 (호스트가 토글 가능)
    wakeWordEnabled: boolean;
    // isPublishing 시작 시간 (타임아웃 감지용)
    publishingStartTime: number;
    // 회의 주제
    roomTopic?: string;
    // 참여자 발언 통계 (코칭 패널용)
    participantSpeakingStats: Map<string, ParticipantSpeakingStats>;
    // 통계 업데이트 인터벌
    statsUpdateInterval: NodeJS.Timeout | null;
    // Dominant speaker 알림 기록 (중복 방지)
    dominantAlertSent: boolean;
    // 타임라인 키워드 기능 (30초 단위)
    timelineStartTime: number;
    // 현재 분의 발화 수집 (5초마다 LLM으로 키워드 추출)
    pendingTranscripts: Array<{ speaker: string; text: string; timestamp: number }>;
    timelineInterval?: NodeJS.Timeout;
    lastTimelineMinuteIndex: number;
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
    private readonly MAX_CONVERSATION_TURNS = 30;     // 최근 30턴까지 기억
    private readonly CONVERSATION_EXPIRE_MS = 300000; // 5분 지나면 대화 리셋

    constructor(
        private configService: ConfigService,
        private sttService: SttService,
        private llmService: LlmService,
        private ttsService: TtsService,
        @Inject(RAG_CLIENT) private ragClient: IRagClient,
        private intentClassifier: IntentClassifierService,
        private visionService: VisionService,
        private agentRouter: AgentRouterService,
        private opinionService: OpinionService,
        private perplexityService: PerplexityService,
        private calendarService: CalendarService,
        @Inject(forwardRef(() => require('./livekit.service').LivekitService))
        private livekitService: LivekitService,
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
            // 마이크 오디오만 STT 처리 (화면 공유 오디오는 제외)
            const isScreenShareAudio = publication.source === TrackSource.SOURCE_SCREENSHARE_AUDIO;
            if (track.kind === TrackKind.KIND_AUDIO && !participant.identity.startsWith('ai-bot') && !isScreenShareAudio) {
                this.logger.log(`[오디오 트랙 구독] ${participant.identity} (source: ${publication.source})`);
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

                // RAG 서버에 참여자 입장 전송 (호스트 모드일 때, 호스트 아닌 경우)
                if (context?.hostOnlyMode && participant.identity !== context.hostIdentity) {
                    this.ragClient.participantJoined(roomId, {
                        id: participant.identity,
                        name: participant.name || participant.identity,
                        role: 'participant',
                    }).catch(err => {
                        this.logger.warn(`[RAG 참여자 입장] 전송 실패: ${err.message}`);
                    });
                }
            }
        });

        room.on(RoomEvent.ParticipantDisconnected, (participant: RemoteParticipant) => {
            this.logger.log(`[참여자 퇴장] ${participant.identity}`);

            // RAG 서버에 참여자 퇴장 전송 (AI 봇 제외)
            if (!participant.identity.startsWith('ai-bot')) {
                const context = this.activeRooms.get(roomId);
                if (context?.hostOnlyMode) {
                    this.ragClient.participantLeft(roomId, participant.identity).catch(err => {
                        this.logger.warn(`[RAG 참여자 퇴장] 전송 실패: ${err.message}`);
                    });
                }
            }

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
                                this.logger.log(`[자동 퇴장 실행] 유예 시간 30초 경과 - cleanup 포함`);
                                this.stopBotWithCleanup(roomId);
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
            this.logger.error(`[봇 연결 끊김] roomId=${roomId}, 사유: ${reason || 'UNKNOWN'}`);
            this.cleanupRoom(roomId);
        });

        room.on(RoomEvent.Reconnecting, () => {
            this.logger.warn(`[봇 재연결 시도 중] roomId=${roomId}`);
        });

        room.on(RoomEvent.Reconnected, () => {
            this.logger.log(`[봇 재연결 성공] roomId=${roomId}`);
        });

        room.on(RoomEvent.ConnectionQualityChanged, (quality: any, participant: any) => {
            if (participant?.identity?.includes('ai-bot')) {
                this.logger.log(`[봇 연결 품질] ${quality} (roomId=${roomId})`);
            }
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

                // 클라이언트 준비 완료 → 인삿말 시작
                if (message.type === 'CLIENT_READY') {
                    if (!context.greetingDone) {
                        this.logger.log(`[CLIENT_READY] 클라이언트 준비 완료 - 인삿말 시작`);
                        context.greetingDone = true;
                        this.greetOnJoin(roomId);
                    }
                    return;
                }

                // AI 음소거 토글
                if (message.type === 'AI_MUTE') {
                    const muted = message.muted === true;
                    context.aiMuted = muted;
                    // 음소거 ON이면 현재 재생 중인 오디오도 즉시 중단
                    if (muted) {
                        context.shouldInterrupt = true;
                    }
                    this.logger.log(`[AI 음소거] ${muted ? 'ON (오디오 중단)' : 'OFF'} by ${participant?.identity || 'unknown'}`);
                    return;
                }

                // 호스트 전용 코칭 모드 활성화
                if (message.type === 'HOST_MODE_ENABLE') {
                    context.hostOnlyMode = message.enabled === true;
                    context.hostIdentity = message.hostIdentity || participant?.identity || null;
                    this.logger.log(`[호스트 모드] ${context.hostOnlyMode ? 'ON' : 'OFF'} - host: ${context.hostIdentity}`);

                    // RAG 서버에 호스트 입장 전송
                    if (context.hostOnlyMode && context.hostIdentity) {
                        const hostParticipant = context.room.remoteParticipants.get(context.hostIdentity);
                        this.ragClient.participantJoined(roomId, {
                            id: context.hostIdentity,
                            name: hostParticipant?.name || context.hostIdentity,
                            role: 'host',
                        }).catch(err => {
                            this.logger.warn(`[RAG 호스트 입장] 전송 실패: ${err.message}`);
                        });
                    }
                    return;
                }

                // Wake word 모드 토글 (호스트 전용)
                if (message.type === 'WAKE_WORD_TOGGLE') {
                    // 호스트만 토글 가능
                    if (participant?.identity === context.hostIdentity) {
                        context.wakeWordEnabled = message.enabled === true;
                        this.logger.log(`[Wake Word] ${context.wakeWordEnabled ? 'ON' : 'OFF'} by host`);
                    }
                    return;
                }

                // 호스트 전용 AI 쿼리 (Wake word 대체)
                if (message.type === 'HOST_AI_QUERY') {
                    if (context.hostOnlyMode && participant?.identity === context.hostIdentity) {
                        this.logger.log(`[호스트 AI 쿼리] ${message.query}`);
                        // 호스트가 직접 AI 질문 - 처리 로직 호출 (비동기)
                        this.processHostQuery(roomId, message.query, participant.identity).catch(err => {
                            this.logger.error(`[호스트 쿼리 에러] ${err.message}`);
                        });
                    }
                    return;
                }

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
                } else if (message.type === 'DESIGN_BOARD_START') {
                    // 설계 보드 열림 - 설계 모드 활성화
                    if (context.designModeActive) {
                        this.logger.debug(`[모드 변경] 설계 보드 START 무시 (이미 ON)`);
                        return;
                    }
                    context.designModeActive = true;
                    context.designModeOpenTime = now;
                    this.logger.log(`[모드 변경] 설계 모드 ON by ${participant?.identity || 'unknown'}`);
                } else if (message.type === 'DESIGN_BOARD_END') {
                    // 설계 보드 닫힘 - 설계 모드 비활성화
                    if (!context.designModeActive) {
                        this.logger.debug(`[모드 변경] 설계 보드 END 무시 (이미 OFF)`);
                        return;
                    }
                    // Grace period 체크
                    const DESIGN_GRACE_PERIOD_MS = 1000;
                    if (context.designModeOpenTime > 0 && now - context.designModeOpenTime < DESIGN_GRACE_PERIOD_MS) {
                        this.logger.debug(`[모드 변경] 설계 보드 END 무시 (grace period)`);
                        return;
                    }
                    context.designModeActive = false;
                    context.designModeOpenTime = 0;
                    context.pendingDiagramExplanation = undefined;
                    this.logger.log(`[모드 변경] 설계 모드 OFF`);
                } else if (message.type === 'DESIGN_BOARD_DIAGRAMS_GENERATED') {
                    // 다이어그램 생성 완료 - 자동 설명 트리거
                    this.logger.log(`[설계 모드] 다이어그램 생성 완료 - types: ${message.types?.join(', ')}`);
                    if (context.designModeActive && message.types?.length > 0) {
                        context.pendingDiagramExplanation = {
                            types: message.types,
                            mermaidCodes: message.mermaidCodes || {},
                        };
                        // 자동 설명 실행
                        this.explainGeneratedDiagrams(roomId, message.types, message.mermaidCodes || {});
                    }
                } else if (message.type === 'PDF_QUESTION') {
                    // PDF 텍스트 선택 후 AI 질문
                    this.logger.log(`[PDF 질문] 수신 - question: "${message.question?.substring(0, 50)}...", context: ${message.context}`);
                    this.handlePdfQuestion(
                        roomId,
                        message.question || '',
                        message.context || '',
                        participant?.identity || 'unknown'
                    );
                } else if (message.type === 'BOARD_TRANSFORM_REQUEST') {
                    // 공유 보드 스케치 → 다이어그램 변환 요청
                    this.logger.log(`[공유 보드 변환] 요청 수신 - 이미지 크기: ${(message.imageBase64?.length / 1024).toFixed(1)}KB`);
                    this.handleBoardTransform(
                        roomId,
                        message.imageBase64 || '',
                        participant?.identity || 'unknown'
                    );
                } else if (message.type === 'QUIZ_GENERATE_REQUEST') {
                    // 스터디 퀴즈 생성 요청
                    this.logger.log(`[스터디 퀴즈] 생성 요청 - 문제수: ${message.questionCount}, 유형: ${message.quizType}, QA히스토리: ${message.qaHistory?.length || 0}개`);
                    this.handleQuizGenerate(
                        roomId,
                        message.questionCount || 5,
                        message.quizType || 'mixed',
                        message.qaHistory || [],
                        participant?.identity || 'unknown'
                    );
                } else if (message.type === 'QUIZ_EVALUATE_REQUEST') {
                    // 퀴즈 답변 평가 요청
                    this.logger.log(`[스터디 퀴즈] 평가 요청 - 답변: "${message.userAnswer?.substring(0, 30)}..."`);
                    this.handleQuizEvaluate(
                        roomId,
                        message.question,
                        message.userAnswer || '',
                        participant?.identity || 'unknown'
                    );
                }
                // ============================================================
                // Perplexity 모드 (WFC 기반 흐름 제어)
                // ============================================================
                else if (message.type === 'PERPLEXITY_START') {
                    if (context.perplexityModeActive) {
                        this.logger.debug(`[Perplexity] START 무시 (이미 ON)`);
                        return;
                    }
                    context.perplexityModeActive = true;
                    this.perplexityService.startSession(roomId);

                    // 참여자 추가 (remoteParticipants + 메시지 발신자)
                    const addedParticipants: string[] = [];
                    room.remoteParticipants.forEach((p) => {
                        if (!p.identity.includes('bot') && !p.identity.includes('agent')) {
                            this.perplexityService.addParticipant(roomId, p.identity, p.name || p.identity);
                            addedParticipants.push(p.identity);
                        }
                    });

                    // 메시지 발신자도 추가 (중복 방지)
                    if (participant && !addedParticipants.includes(participant.identity)) {
                        if (!participant.identity.includes('bot') && !participant.identity.includes('agent')) {
                            this.perplexityService.addParticipant(roomId, participant.identity, participant.name || participant.identity);
                            addedParticipants.push(participant.identity);
                        }
                    }

                    this.logger.log(`[Perplexity] 모드 ON by ${participant?.identity || 'unknown'} - 참여자: ${addedParticipants.join(', ')}`);
                } else if (message.type === 'PERPLEXITY_END') {
                    if (!context.perplexityModeActive) {
                        this.logger.debug(`[Perplexity] END 무시 (이미 OFF)`);
                        return;
                    }
                    context.perplexityModeActive = false;
                    this.perplexityService.endSession(roomId);
                    this.logger.log(`[Perplexity] 모드 OFF`);
                } else if (message.type === 'ENTROPY_REPORT' || message.type === 'STATE_UPDATE') {
                    // Perplexity 상태 업데이트 처리
                    if (!context.perplexityModeActive) return;

                    this.handlePerplexityMessage(roomId, message as PerplexityMessage, participant?.identity);
                }
            } catch (error) {
                // JSON 파싱 실패는 무시 (다른 메시지일 수 있음)
            }
        });

        try {
            await room.connect(livekitUrl, botToken);

            // Room metadata에서 회의 주제 추출
            let roomTopic: string | undefined;
            try {
                if (room.metadata) {
                    const meta = JSON.parse(room.metadata);
                    roomTopic = meta.topic;
                    this.logger.log(`[회의 주제] ${roomTopic || '(없음)'}`);
                }
            } catch (e) {
                this.logger.warn(`[metadata 파싱 실패] ${e.message}`);
            }

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
                // 설계 모드 초기화
                designModeActive: false,
                designModeOpenTime: 0,
                // 인삿말 대기 (클라이언트 준비 완료 후 시작)
                greetingDone: false,
                // AI 음소거 초기값
                aiMuted: false,
                // Perplexity 모드 초기화
                perplexityModeActive: false,
                // 호스트 전용 코칭 모드 초기화 (기본 활성화)
                hostOnlyMode: true,
                hostIdentity: null,
                wakeWordEnabled: false,
                // isPublishing 타임아웃 감지용
                publishingStartTime: 0,
                // 회의 주제
                roomTopic,
                // 참여자 발언 통계 초기화
                participantSpeakingStats: new Map(),
                statsUpdateInterval: null,
                dominantAlertSent: false,
                // 타임라인 키워드 (30초 단위)
                timelineStartTime: Date.now(),
                pendingTranscripts: [],
                lastTimelineMinuteIndex: 0,
            };
            this.activeRooms.set(roomId, context);

            this.startArmedTimeoutChecker(roomId);
            this.startSilentParticipantChecker(roomId);
            this.startTopicSummaryChecker(roomId);
            this.startSpeakingStatsChecker(roomId);
            // 타임라인 5초 인터벌 시작
            this.startTimelineInterval(roomId);

            this.logger.log(`[봇 입장 성공] 참여자: ${room.remoteParticipants.size}명`);

            // 입장 인사는 클라이언트가 CLIENT_READY 메시지를 보낼 때까지 대기
            this.logger.log(`[봇 입장] 클라이언트 준비 대기 중 (CLIENT_READY 메시지 대기)`);

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

        // AI 음소거 상태면 인사 스킵
        if (context.aiMuted) {
            this.logger.log(`[입장 인사 스킵] AI 음소거 상태`);
            return;
        }

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
     * PDF 텍스트 선택 후 AI 질문 처리
     */
    private async handlePdfQuestion(
        roomId: string,
        question: string,
        pdfContext: string,
        requesterId: string
    ): Promise<void> {
        const context = this.activeRooms.get(roomId);
        if (!context) return;

        this.logger.log(`[PDF 질문] 처리 시작 from ${requesterId}: "${question.substring(0, 50)}..."`);

        try {
            // PDF 질문은 RAG 스킵 (속도 개선: 3~5초 단축)
            // PDF 선택 텍스트에 대한 질문은 회의 내용 검색이 불필요
            const fullContext = `
=== PDF 선택 텍스트 ===
${question}

=== PDF 정보 ===
${pdfContext}
`.trim();

            const response = await this.llmService.answerWithContext(
                `다음 PDF에서 선택한 텍스트에 대해 설명해주세요:\n\n"${question}"`,
                fullContext,
                'PDF 문서'
            );

            // DataChannel로 응답 전송 (search_answer 형식 사용)
            const searchMessage = {
                type: 'search_answer',
                text: response,
                category: 'PDF 분석',
                minutes: [],
                results: [],
            };

            const encoder = new TextEncoder();
            // 질문한 사람에게만 응답 전송 (개인 학습용 - 방 전체 브로드캐스트 X)
            await context.room.localParticipant.publishData(
                encoder.encode(JSON.stringify(searchMessage)),
                { reliable: true, destination_identities: [requesterId] }
            );

            this.logger.log(`[PDF 질문] 응답 전송 완료 (to: ${requesterId}): ${response.substring(0, 50)}...`);

            // TTS 읽기 비활성화 - 인라인 텍스트로만 표시

        } catch (error) {
            this.logger.error(`[PDF 질문] 처리 실패: ${error.message}`);

            // 에러 응답 전송 (질문한 사람에게만) - 연결 끊김 방어
            try {
                if (context.room?.localParticipant) {
                    const errorMessage = {
                        type: 'search_answer',
                        text: 'PDF 질문을 처리하는 중 오류가 발생했습니다. 다시 시도해주세요.',
                        category: 'PDF 분석',
                        minutes: [],
                        results: [],
                    };

                    const encoder = new TextEncoder();
                    await context.room.localParticipant.publishData(
                        encoder.encode(JSON.stringify(errorMessage)),
                        { reliable: true, destination_identities: [requesterId] }
                    );
                }
            } catch (publishError) {
                // 연결 끊김 등의 에러는 무시
                this.logger.debug(`[PDF 질문] 에러 응답 전송 실패 (연결 끊김): ${publishError.message}`);
            }
        }
    }

    /**
     * 공유 보드 스케치 → 다이어그램 변환 처리
     */
    private async handleBoardTransform(
        roomId: string,
        imageBase64: string,
        requesterId: string
    ): Promise<void> {
        const context = this.activeRooms.get(roomId);
        if (!context) return;

        this.logger.log(`[공유 보드 변환] 처리 시작 from ${requesterId}`);

        try {
            // Vision Service로 스케치 분석
            const sketchPrompt = `이 손그림/스케치를 분석하고 Mermaid 다이어그램 코드로 변환해주세요.

## 분석 가이드:
1. 그림에서 박스, 원, 화살표, 텍스트 등의 요소를 식별하세요
2. 요소들 간의 관계(연결, 흐름)를 파악하세요
3. 적절한 다이어그램 타입을 선택하세요:
   - 흐름도(flowchart): 프로세스, 의사결정, 순서가 있는 경우
   - 시퀀스(sequence): 시간순 상호작용, 메시지 교환
   - 마인드맵(mindmap): 아이디어 정리, 계층 구조

## 응답 형식 (JSON만 출력):
{
  "description": "그림에 대한 간단한 설명 (한국어)",
  "diagramType": "flowchart | sequence | mindmap",
  "mermaidCode": "실제 Mermaid 코드"
}

손글씨가 알아보기 어려우면 최대한 추측해서 변환하세요. 그림이 명확하지 않으면 기본 흐름도로 만들어주세요.`;

            const visionResult = await this.visionService.analyzeScreenShare(
                imageBase64,
                sketchPrompt,
                { screenWidth: 1920, screenHeight: 1080 }
            );

            this.logger.log(`[공유 보드 변환] Vision 응답: ${visionResult.text.substring(0, 100)}...`);

            // JSON 파싱
            let result = {
                description: '그림을 분석했습니다.',
                mermaidCode: '',
            };

            try {
                const jsonMatch = visionResult.text.match(/\{[\s\S]*\}/);
                if (jsonMatch) {
                    const parsed = JSON.parse(jsonMatch[0]);
                    result.description = parsed.description || result.description;
                    result.mermaidCode = parsed.mermaidCode || '';
                }
            } catch (parseError) {
                this.logger.warn(`[공유 보드 변환] JSON 파싱 실패: ${parseError.message}`);
                result.description = visionResult.text.slice(0, 200);
            }

            // 결과 전송 (모든 참가자에게)
            const transformResult = {
                type: 'BOARD_TRANSFORM_RESULT',
                result: {
                    description: result.description,
                    mermaidCode: result.mermaidCode,
                },
            };

            const encoder = new TextEncoder();
            await context.room.localParticipant.publishData(
                encoder.encode(JSON.stringify(transformResult)),
                { reliable: true }
            );

            this.logger.log(`[공유 보드 변환] 결과 전송 완료`);

        } catch (error) {
            this.logger.error(`[공유 보드 변환] 실패: ${error.message}`);

            // 에러 응답 전송
            const errorResult = {
                type: 'BOARD_TRANSFORM_RESULT',
                result: {
                    description: '스케치 분석 중 오류가 발생했습니다. 다시 시도해주세요.',
                    mermaidCode: '',
                },
            };

            const encoder = new TextEncoder();
            await context.room.localParticipant.publishData(
                encoder.encode(JSON.stringify(errorResult)),
                { reliable: true }
            );
        }
    }

    /**
     * 스터디 퀴즈 생성
     */
    private async handleQuizGenerate(
        roomId: string,
        questionCount: number,
        quizType: 'multiple_choice' | 'short_answer' | 'ox' | 'mixed',
        qaHistory: Array<{ question: string; answer: string; context?: string; timestamp?: number }>,
        requesterId: string
    ): Promise<void> {
        const context = this.activeRooms.get(roomId);
        if (!context) return;

        this.logger.log(`[스터디 퀴즈] 생성 시작 - ${questionCount}문제, 유형: ${quizType}, QA히스토리: ${qaHistory.length}개`);

        const encoder = new TextEncoder();

        // 퀴즈 유형 설명
        const typeInstructions = {
            multiple_choice: '객관식 문제 (4개 선택지)',
            short_answer: '주관식 단답형 문제',
            ox: 'O/X 진위형 문제',
            mixed: '객관식, 주관식, O/X를 골고루 섞어서',
        };

        // 퀴즈 생성 함수
        const generateQuizFromContent = async (contentContext: string, source: string): Promise<any[]> => {
            const prompt = `당신은 학습 퀴즈 출제 전문가입니다. 다음 내용을 바탕으로 ${questionCount}개의 퀴즈 문제를 생성해주세요.

## 참고 내용
${contentContext}

## 퀴즈 유형
${typeInstructions[quizType]}

## 출력 형식 (JSON 배열만 출력)
[
  {
    "id": 1,
    "question": "문제 내용",
    "type": "multiple_choice" | "short_answer" | "ox",
    "options": ["선택지1", "선택지2", "선택지3", "선택지4"],
    "correctAnswer": "정답",
    "explanation": "정답 해설 (왜 이것이 정답인지)",
    "relatedContent": "관련 내용 출처"
  }
]

## 주의사항
- 문제는 학습자의 이해도를 점검할 수 있도록 출제
- 너무 쉽거나 너무 어렵지 않게 중간 난이도로
- 해설은 학습에 도움이 되도록 상세하게
- JSON만 출력하세요 (다른 텍스트 없이)`;

            const response = await this.llmService.sendMessagePure(prompt, 2000);
            this.logger.log(`[스터디 퀴즈] ${source} 기반 LLM 응답: ${response.substring(0, 100)}...`);

            const jsonMatch = response.match(/\[[\s\S]*\]/);
            if (jsonMatch) {
                return JSON.parse(jsonMatch[0]);
            }
            throw new Error('JSON 파싱 실패');
        };

        try {
            // 우선순위: 회의 내용 (RAG) -> PDF 임베딩 -> Q&A 히스토리
            // 전략: Q&A 히스토리로 즉시 생성 + RAG 10초 타임아웃으로 병렬 시도

            let qaBasedQuestions: any[] | null = null;
            let ragBasedQuestions: any[] | null = null;

            // Q&A 히스토리 기반 즉시 생성 (fallback)
            const qaPromise = (async () => {
                if (qaHistory.length > 0) {
                    const qaContent = qaHistory.map((qa, idx) =>
                        `### 질문 ${idx + 1}\nQ: ${qa.question}\nA: ${qa.answer}${qa.context ? `\n참고: ${qa.context.substring(0, 500)}` : ''}`
                    ).join('\n\n');

                    this.logger.log(`[스터디 퀴즈] Q&A 히스토리 기반 생성 시작`);
                    return await generateQuizFromContent(
                        `### 문서 Q&A 히스토리\n${qaContent.substring(0, 4000)}`,
                        'Q&A히스토리'
                    );
                }
                return null;
            })();

            // RAG 기반 생성 (10초 타임아웃)
            const ragPromise = (async () => {
                try {
                    if (!this.ragClient.isConnected(roomId)) {
                        this.logger.log(`[스터디 퀴즈] RAG 미연결`);
                        return null;
                    }

                    // 10초 타임아웃
                    const timeoutPromise = new Promise<null>((resolve) => {
                        setTimeout(() => resolve(null), 10000);
                    });

                    const ragQueryPromise = (async () => {
                        const ragResult = await this.ragClient.sendQuestionWithSources(
                            roomId,
                            '지금까지 회의에서 논의된 주요 내용과 PDF에서 다룬 핵심 개념을 알려줘'
                        );

                        if (ragResult && ragResult.sources && ragResult.sources.length > 0) {
                            const meetingContext = ragResult.sources
                                .map((s) => `[${s.speaker || '발언자'}] ${s.text}`)
                                .join('\n\n');

                            this.logger.log(`[스터디 퀴즈] RAG 컨텍스트 ${ragResult.sources.length}개 조회됨`);

                            return await generateQuizFromContent(
                                `### 회의 및 PDF 내용\n${meetingContext.substring(0, 4000)}`,
                                'RAG'
                            );
                        }
                        return null;
                    })();

                    return await Promise.race([ragQueryPromise, timeoutPromise]);
                } catch (error) {
                    this.logger.warn(`[스터디 퀴즈] RAG 조회 실패: ${error.message}`);
                    return null;
                }
            })();

            // 병렬 실행
            const [qaResult, ragResult] = await Promise.all([qaPromise, ragPromise]);
            qaBasedQuestions = qaResult;
            ragBasedQuestions = ragResult;

            // 결과 선택: RAG 우선, 없으면 Q&A 히스토리
            let questions: any[] = [];
            let source = '';

            if (ragBasedQuestions && ragBasedQuestions.length > 0) {
                questions = ragBasedQuestions;
                source = 'RAG (회의 내용 + PDF)';
                this.logger.log(`[스터디 퀴즈] RAG 기반 퀴즈 사용`);
            } else if (qaBasedQuestions && qaBasedQuestions.length > 0) {
                questions = qaBasedQuestions;
                source = 'Q&A 히스토리';
                this.logger.log(`[스터디 퀴즈] Q&A 히스토리 기반 퀴즈 사용`);
            } else {
                throw new Error('퀴즈 생성할 컨텐츠가 없습니다. 문서를 검색하거나 회의를 진행해주세요.');
            }

            // 결과 전송
            const quizResult = {
                type: 'QUIZ_GENERATE_RESULT',
                questions,
                source,
            };

            await context.room.localParticipant.publishData(
                encoder.encode(JSON.stringify(quizResult)),
                { reliable: true }
            );

            this.logger.log(`[스터디 퀴즈] ${questions.length}개 문제 생성 완료 (출처: ${source})`);

        } catch (error) {
            this.logger.error(`[스터디 퀴즈] 생성 실패: ${error.message}`);

            // 에러 응답
            const errorResult = {
                type: 'QUIZ_GENERATE_RESULT',
                questions: [],
                error: error.message || '퀴즈 생성 중 오류가 발생했습니다. 다시 시도해주세요.',
            };

            await context.room.localParticipant.publishData(
                encoder.encode(JSON.stringify(errorResult)),
                { reliable: true }
            );
        }
    }

    /**
     * 퀴즈 답변 평가 및 피드백 생성
     */
    private async handleQuizEvaluate(
        roomId: string,
        question: any,
        userAnswer: string,
        requesterId: string
    ): Promise<void> {
        const context = this.activeRooms.get(roomId);
        if (!context) return;

        this.logger.log(`[스터디 퀴즈] 평가 시작 - 질문: "${question?.question?.substring(0, 30)}...", 답변: "${userAnswer.substring(0, 30)}..."`);

        try {
            const prompt = `당신은 학습 피드백 전문가입니다. 다음 퀴즈 답변을 평가하고 피드백을 제공해주세요.

## 문제
${question?.question}

## 문제 유형
${question?.type === 'multiple_choice' ? '객관식' : question?.type === 'ox' ? 'O/X' : '주관식'}

## 정답
${question?.correctAnswer}

## 학습자 답변
${userAnswer}

## 해설
${question?.explanation}

## 관련 내용
${question?.relatedContent || '없음'}

## 출력 형식 (JSON만 출력)
{
  "isCorrect": true/false,
  "feedback": "학습자의 답변에 대한 구체적인 피드백 (맞았다면 칭찬과 추가 설명, 틀렸다면 왜 틀렸는지 분석)",
  "studyGuide": "틀린 경우 어떤 부분을 다시 공부해야 하는지 구체적인 가이드 (맞은 경우는 심화 학습 제안)"
}

## 평가 기준
- 객관식/O/X: 정확히 일치해야 정답
- 주관식: 핵심 개념이 포함되어 있으면 정답으로 인정 (유연하게 평가)
- 시간 초과나 답변 없음은 오답 처리`;

            const response = await this.llmService.sendMessagePure(prompt, 500);

            this.logger.log(`[스터디 퀴즈] 평가 응답: ${response.substring(0, 100)}...`);

            // JSON 파싱
            let evaluation = {
                questionId: question?.id || 0,
                userAnswer,
                isCorrect: false,
                feedback: '평가를 완료했습니다.',
                studyGuide: '',
            };

            try {
                const jsonMatch = response.match(/\{[\s\S]*\}/);
                if (jsonMatch) {
                    const parsed = JSON.parse(jsonMatch[0]);
                    evaluation.isCorrect = parsed.isCorrect || false;
                    evaluation.feedback = parsed.feedback || evaluation.feedback;
                    evaluation.studyGuide = parsed.studyGuide || '';
                }
            } catch (parseError) {
                this.logger.warn(`[스터디 퀴즈] 평가 JSON 파싱 실패: ${parseError.message}`);
                // 단순 비교로 폴백
                evaluation.isCorrect = userAnswer.trim().toLowerCase() === question?.correctAnswer?.trim().toLowerCase();
                evaluation.feedback = evaluation.isCorrect ? '정답입니다!' : `틀렸습니다. 정답은 "${question?.correctAnswer}"입니다.`;
                evaluation.studyGuide = !evaluation.isCorrect ? question?.explanation || '' : '';
            }

            // 결과 전송
            const evalResult = {
                type: 'QUIZ_EVALUATE_RESULT',
                evaluation,
            };

            const encoder = new TextEncoder();
            await context.room.localParticipant.publishData(
                encoder.encode(JSON.stringify(evalResult)),
                { reliable: true }
            );

            this.logger.log(`[스터디 퀴즈] 평가 완료 - 정답: ${evaluation.isCorrect}`);

        } catch (error) {
            this.logger.error(`[스터디 퀴즈] 평가 실패: ${error.message}`);

            // 에러 응답 (단순 비교로 폴백)
            const isCorrect = userAnswer.trim().toLowerCase() === question?.correctAnswer?.trim().toLowerCase();
            const evalResult = {
                type: 'QUIZ_EVALUATE_RESULT',
                evaluation: {
                    questionId: question?.id || 0,
                    userAnswer,
                    isCorrect,
                    feedback: isCorrect ? '정답입니다!' : `틀렸습니다. 정답은 "${question?.correctAnswer}"입니다.`,
                    studyGuide: !isCorrect ? (question?.explanation || '해당 내용을 다시 복습해보세요.') : '',
                },
            };

            const encoder = new TextEncoder();
            await context.room.localParticipant.publishData(
                encoder.encode(JSON.stringify(evalResult)),
                { reliable: true }
            );
        }
    }

    /**
     * Perplexity 메시지 처리 (WFC 기반 흐름 제어)
     */
    private async handlePerplexityMessage(
        roomId: string,
        message: PerplexityMessage,
        senderId?: string
    ): Promise<void> {
        const context = this.activeRooms.get(roomId);
        if (!context || !context.perplexityModeActive) return;

        // TRANSCRIPT는 항상 저장 (AI 응답만 스킵)
        const isSpeakingOrPublishing = context.botState === BotState.SPEAKING || context.isPublishing;

        // TRANSCRIPT가 아닌 메시지는 말하는 중이면 스킵
        if (isSpeakingOrPublishing && message.type !== 'TRANSCRIPT') {
            this.logger.debug(`[Perplexity] 메시지 스킵 (발화 중): ${message.type}`);
            return;
        }

        try {
            // PerplexityService에 메시지 전달 (TRANSCRIPT는 항상 저장됨)
            const result = await this.perplexityService.handleMessage(roomId, message);

            // 말하는 중이면 AI 응답만 스킵
            if (isSpeakingOrPublishing) {
                this.logger.debug(`[Perplexity] AI 응답 스킵 (발화 중)`);
                return;
            }

            if (result?.action) {
                this.logger.log(`[Perplexity] 액션 생성: ${result.action.type}`);

                // 액션 결과를 클라이언트에 브로드캐스트
                const actionMessage = {
                    type: 'ACTION',
                    payload: result.action,
                    senderId: 'ai-bot',
                    timestamp: Date.now(),
                };

                const encoder = new TextEncoder();
                await context.room.localParticipant.publishData(
                    encoder.encode(JSON.stringify(actionMessage)),
                    { reliable: true }
                );

                // AI 응답이 있으면 TTS로 말하기
                if (result.response) {
                    this.logger.log(`[Perplexity] AI 응답: "${result.response.substring(0, 50)}..."`);

                    // ★ 상태 관리: isPublishing과 botState 설정
                    const requestId = ++context.currentRequestId;
                    context.isPublishing = true;
                    context.publishingStartTime = Date.now();
                    context.botState = BotState.SPEAKING;

                    try {
                        await this.speakAndPublish(context, roomId, requestId, result.response);
                    } finally {
                        // ★ 항상 상태 초기화 (requestId 체크 없이)
                        context.isPublishing = false;
                        context.publishingStartTime = 0;
                        context.botState = BotState.SLEEP;
                    }
                }
            }
        } catch (error) {
            this.logger.error(`[Perplexity] 메시지 처리 실패: ${error.message}`);
            // 에러 시에도 상태 초기화
            context.isPublishing = false;
            context.publishingStartTime = 0;
        }
    }

    /**
     * CDR Flowchart 파싱 요청 처리 및 응답 전송
     */
    private async handleCDRFlowchartRequest(
        roomId: string,
        content: string,
        preserveExisting: boolean,
        requesterId: string
    ): Promise<void> {
        const context = this.activeRooms.get(roomId);
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
        roomId: string,
        content: string,
        preserveExisting: boolean,
        requesterId: string
    ): Promise<void> {
        const context = this.activeRooms.get(roomId);
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
        roomId: string,
        nodes: any[],
        edges: any[],
        language: string,
        requesterId: string
    ): Promise<void> {
        const context = this.activeRooms.get(roomId);
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

        // ★ Pre-buffer: 음성 감지 전 프레임 저장 (첫 음절 손실 방지)
        const PRE_BUFFER_FRAMES = 15;  // ~150ms 선행 저장
        let preBuffer: Buffer[] = [];
        let isRecording = false;  // 실제 녹음 시작 여부
        let speechStartTime: number | null = null;  // ★ 발언 시작 시간 (동시발화 순서 보장용)

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

            // ★ isPublishing 타임아웃 체크 (60초 이상 stuck 방지)
            const PUBLISHING_TIMEOUT_MS = 60000;
            if (context?.isPublishing && context.publishingStartTime > 0) {
                const publishingDuration = Date.now() - context.publishingStartTime;
                if (publishingDuration > PUBLISHING_TIMEOUT_MS) {
                    this.logger.warn(`[오디오] isPublishing 타임아웃 (${(publishingDuration / 1000).toFixed(1)}초) - 강제 리셋`);
                    context.isPublishing = false;
                    context.publishingStartTime = 0;
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

            // VAD 처리 (Pre-buffer 적용)
            if (isVoice) {
                voiceCount++;
                if (context && voiceCount >= MIN_VOICE_FRAMES) {
                    context.lastInteractionTime = Date.now();
                }
                if (decibel > STRONG_VOICE_THRESHOLD) {
                    silenceCount = 0;
                }

                // ★ 음성 시작 시 pre-buffer 포함
                if (!isRecording && voiceCount >= 2) {
                    isRecording = true;
                    speechStartTime = Date.now();  // ★ 발언 시작 시간 기록
                    // pre-buffer의 모든 프레임을 audioBuffer 앞에 추가
                    audioBuffer.push(...preBuffer);
                    preBuffer = [];
                }

                audioBuffer.push(frameBuffer);
            } else if (avgAmplitude > 150 && decibel > -55) {
                // 약한 음성/전이 구간
                if (isRecording) {
                    audioBuffer.push(frameBuffer);
                } else {
                    // 녹음 전이면 pre-buffer에 저장
                    preBuffer.push(frameBuffer);
                    if (preBuffer.length > PRE_BUFFER_FRAMES) {
                        preBuffer.shift();
                    }
                }
                silenceCount++;
            } else {
                // 무음 구간
                if (!isRecording) {
                    // 녹음 전이면 pre-buffer에 저장 (무음도 포함)
                    preBuffer.push(frameBuffer);
                    if (preBuffer.length > PRE_BUFFER_FRAMES) {
                        preBuffer.shift();
                    }
                }
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

                // ★ 발언 시작 시간 저장 (리셋 전에)
                const capturedStartTime = speechStartTime;

                audioBuffer = [];
                silenceCount = 0;
                voiceCount = 0;
                isRecording = false;  // ★ 녹음 상태 리셋
                speechStartTime = null;  // ★ 발언 시작 시간 리셋
                preBuffer = [];       // ★ pre-buffer도 초기화

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

                    this.processAndRespond(roomId, fullAudio, userId, capturedStartTime).catch(err => {
                        this.logger.error(`[처리 에러] ${err.message}`);
                    });
                }
            }
        }
    }

    /**
     * 음성 처리 메인 로직
     * STT → RAG 임베딩 → Intent 분석 → (LLM 교정) → 검색/응답 → TTS
     * @param startTime 발언 시작 시간 (동시발화 순서 보장용)
     */
    private async processAndRespond(roomId: string, audioBuffer: Buffer, userId: string, startTime: number | null = null) {
        const context = this.activeRooms.get(roomId);
        if (!context) return;

        // ================================================
        // [DEBUG] 오디오 파일 저장 (품질 확인용)
        // ================================================
        if (process.env.DEBUG_SAVE_AUDIO === 'true') {
            this.saveDebugAudio(audioBuffer, roomId);
        }

        // ================================================
        // 1. STT (음성 → 텍스트) - 항상 수행 (isPublishing과 무관)
        // ================================================
        const sttStart = Date.now();
        let transcript: string;      // 교정된 결과 (일반 용도)
        let rawTranscript: string;   // 원본 (타임라인 용도)
        try {
            const sttResult = await this.sttService.transcribeFromBufferStreamWithRaw(audioBuffer, 'live-audio.pcm');
            transcript = sttResult.corrected;
            rawTranscript = sttResult.raw;
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
        // endTime = startTime + 오디오 버퍼 길이 (16kHz, 16-bit mono PCM)
        const audioDurationMs = (audioBuffer.length / (16000 * 2)) * 1000;
        const endTime = startTime ? startTime + audioDurationMs : null;
        this.sendToRagForEmbedding(roomId, transcript, userId, startTime, endTime);

        // ★ 타임라인용 발화 수집 (5초마다 LLM으로 키워드 추출)
        // 키워드 힌트로 인한 "아우라" 오인식 제거 후 수집
        const timelineTranscript = rawTranscript
            .replace(/아우라(야|나|요)?/gi, '')
            .replace(/오우라(야)?/gi, '')
            .replace(/어우라(야)?/gi, '')
            .replace(/헤이\s*아우라/gi, '')
            .replace(/\s+/g, ' ')
            .trim();
        if (timelineTranscript.length > 0) {
            this.collectTranscriptForTimeline(roomId, timelineTranscript, userId);
        }

        // ★ 발언 통계 업데이트 (코칭 패널용)
        // 오디오 버퍼에서 발언 시간 계산 (16kHz, 16-bit mono PCM)
        const speakingDurationMs = Math.round((audioBuffer.length / (16000 * 2)) * 1000);
        const participant = context.room.remoteParticipants.get(userId);
        const participantName = participant?.name || userId;
        this.updateParticipantSpeakingStats(context, userId, participantName, speakingDurationMs);

        // ================================================
        // ★ Perplexity 모드: isPublishing과 무관하게 TRANSCRIPT 항상 저장
        // ================================================
        if (context.perplexityModeActive && transcript.trim().length > 0) {
            this.logger.debug(`[Perplexity] Transcript 저장 시도: "${transcript.substring(0, 30)}..."`);

            const transcriptMessage: PerplexityMessage = {
                type: 'TRANSCRIPT',
                payload: {
                    participantId: userId,
                    text: transcript.trim(),
                },
                senderId: userId,
                timestamp: Date.now(),
            };

            // PerplexityService에 직접 전달 (AI 응답은 isPublishing 체크에서 처리)
            const transcriptResult = await this.perplexityService.handleMessage(roomId, transcriptMessage);

            // AI 개입 응답이 있고, 현재 발화 중이 아니면 처리
            if (transcriptResult?.response && !context.isPublishing && context.botState !== BotState.SPEAKING) {
                this.logger.log(`[Perplexity] 텍스트 기반 AI 개입: ${transcriptResult.action?.type}`);
                const requestId = Date.now();
                context.currentRequestId = requestId;
                context.isPublishing = true;
                context.publishingStartTime = Date.now();
                context.botState = BotState.SPEAKING;

                try {
                    await this.speakAndPublish(context, roomId, requestId, transcriptResult.response);
                } finally {
                    context.botState = BotState.ARMED;
                    context.isPublishing = false;
                    context.publishingStartTime = 0;
                    context.lastResponseTime = Date.now();
                }
                return;
            }
        }

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
        const responseStartTime = Date.now();

        this.logger.log(`\n========== [봇 응답 처리] ${userId} ==========`);

        try {
            context.isPublishing = true;
            context.publishingStartTime = Date.now();

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

            // ★ 설계 모드일 때: 다이어그램 관련 질문만 응답
            if (context.designModeActive && intentForContext.isCallIntent) {
                const isDiagramQuestion = this.isDiagramRelatedQuestion(transcript);
                this.logger.log(`[설계 모드] 질문 분석 - 다이어그램 관련: ${isDiagramQuestion}`);

                if (isDiagramQuestion) {
                    // 다이어그램 관련 질문 - 설계 보드 컨텍스트와 함께 응답
                    this.logger.log(`[설계 모드] 다이어그램 질문 처리 - "${transcript.substring(0, 30)}..."`);

                    context.botState = BotState.SPEAKING;

                    // 다이어그램 컨텍스트 구성
                    let diagramContext = '=== 현재 설계 보드 상태 ===\n';
                    if (context.pendingDiagramExplanation) {
                        const { types, mermaidCodes } = context.pendingDiagramExplanation;
                        diagramContext += `생성된 다이어그램: ${types.join(', ')}\n\n`;
                        for (const type of types) {
                            if (mermaidCodes[type]) {
                                diagramContext += `[${type}]\n${mermaidCodes[type].substring(0, 500)}\n\n`;
                            }
                        }
                    }

                    const response = await this.llmService.answerWithContext(
                        transcript,
                        diagramContext,
                        '설계 다이어그램'
                    );

                    await this.speakAndPublish(context, roomId, requestId, response);
                    context.botState = BotState.ARMED;
                    context.lastResponseTime = Date.now();
                    this.logger.log(`[설계 모드] 처리 완료`);
                    return;
                } else {
                    // 다이어그램 관련 없는 질문 - 무시하고 안내
                    this.logger.log(`[설계 모드] 비-다이어그램 질문 스킵 - "${transcript.substring(0, 30)}..."`);
                    context.botState = BotState.SPEAKING;
                    await this.speakAndPublish(
                        context,
                        roomId,
                        requestId,
                        '지금은 설계 보드가 열려 있어요. 다이어그램에 관한 질문을 해주시면 도와드릴게요.'
                    );
                    context.botState = BotState.ARMED;
                    context.lastResponseTime = Date.now();
                    return;
                }
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
                await this.speakAndPublish(context, roomId, requestId, "설계 보드를 열었습니다.");
                context.botState = BotState.ARMED;
                context.lastResponseTime = Date.now();
                return;
            }

            // ================================================
            // 3.7. 캘린더/일정 추천 Intent 처리
            // ================================================
            if (intentAnalysis.isCallIntent && intentAnalysis.isCalendarIntent) {
                this.logger.log(`[캘린더 일정 생성] Intent 감지 - 발화자: ${userId}`);

                try {
                    // 현재 방의 참여자 목록 가져오기
                    const participants = Array.from(context.room.remoteParticipants.values())
                        .filter(p => !p.identity.startsWith('ai-bot'))
                        .map(p => p.identity);
                    participants.push(context.room.localParticipant?.identity || '');

                    const participantCount = participants.filter(p => p && !p.startsWith('ai-bot')).length;

                    // 다음 주 기간 계산
                    const { timeMin, timeMax } = this.calendarService.getNextWeekRange();

                    // 참여자들의 userId 추출 (닉네임에서 _로 구분된 경우)
                    const userIds = participants
                        .filter(p => p && !p.startsWith('ai-bot'))
                        .map(p => p.split('_')[0]); // 임시로 닉네임 사용

                    this.logger.log(`[캘린더] 참여자 ${participantCount}명의 일정 분석 시작`);

                    // 음성으로 처리 중 안내
                    context.botState = BotState.SPEAKING;
                    await this.speakAndPublish(
                        context,
                        roomId,
                        requestId,
                        `${participantCount}명의 참여자 일정을 분석하고 일정을 생성하겠습니다.`
                    );

                    // 공통 빈 시간 검색 (내부 API 키 사용)
                    const freeSlots = await this.calendarService.findCommonFreeSlots({
                        userIds,
                        timeMin,
                        timeMax,
                        durationMinutes: 60,
                    });

                    if (freeSlots.length === 0) {
                        await this.speakAndPublish(
                            context,
                            roomId,
                            requestId,
                            `${participantCount}명의 일정을 확인했지만, 공통으로 비어 있는 시간을 찾지 못했습니다.`
                        );
                        context.botState = BotState.ARMED;
                        context.lastResponseTime = Date.now();
                        return;
                    }

                    // 첫 번째 빈 시간으로 일정 생성
                    const firstSlot = freeSlots[0];
                    const slotDate = new Date(firstSlot.start);
                    const dateStr = slotDate.toISOString().split('T')[0]; // YYYY-MM-DD
                    const timeStr = slotDate.toTimeString().slice(0, 5); // HH:mm

                    // 회의 주제를 일정 제목으로 사용
                    const meetingTopic = context.roomTopic || '팀 미팅';

                    // 일정 생성
                    const createResult = await this.calendarService.addEventToUsers({
                        userIds,
                        title: meetingTopic,
                        date: dateStr,
                        time: timeStr,
                        description: `AURA 회의실에서 자동 생성된 일정입니다.\n회의 주제: ${meetingTopic}`,
                        durationMinutes: 60,
                    });

                    // 결과 포맷팅
                    const dateFormatted = slotDate.toLocaleDateString('ko-KR', {
                        month: 'long',
                        day: 'numeric',
                        weekday: 'short',
                    });
                    const timeFormatted = slotDate.toLocaleTimeString('ko-KR', {
                        hour: '2-digit',
                        minute: '2-digit',
                    });

                    let responseText: string;
                    if (createResult.success) {
                        responseText = `${dateFormatted} ${timeFormatted}에 "${meetingTopic}" 일정을 생성했습니다. ${createResult.successCount}명의 캘린더에 추가되었습니다.`;
                    } else {
                        responseText = `일정 생성에 실패했습니다. Google 캘린더 연동을 확인해주세요.`;
                    }

                    // 음성 응답
                    await this.speakAndPublish(context, roomId, requestId, responseText);
                    context.botState = BotState.ARMED;
                    context.lastResponseTime = Date.now();

                    // DataChannel로 캘린더 결과 전송 (UI 표시용)
                    const calendarMessage = {
                        type: 'CALENDAR_EVENT_CREATED',
                        event: {
                            title: meetingTopic,
                            date: dateStr,
                            time: timeStr,
                            durationMinutes: 60,
                        },
                        participantCount,
                        result: createResult,
                    };
                    const encoder = new TextEncoder();
                    await context.room.localParticipant.publishData(
                        encoder.encode(JSON.stringify(calendarMessage)),
                        { reliable: true }
                    );

                    return;
                } catch (error) {
                    this.logger.error(`[캘린더] 일정 생성 실패: ${error.message}`);
                    await this.speakAndPublish(
                        context,
                        roomId,
                        requestId,
                        "죄송합니다. 일정 생성 중 오류가 발생했습니다. Google 캘린더 연동이 필요할 수 있습니다."
                    );
                    context.botState = BotState.ARMED;
                    return;
                }
            }

            // ================================================
            // 4. 웨이크워드 판단 + LLM 교정 (필요시만!)
            // ================================================
            let shouldRespond = intentAnalysis.isCallIntent;

            // Wake word 비활성화 상태에서는 무시 (호스트가 활성화해야 동작)
            if (!context.wakeWordEnabled) {
                shouldRespond = false;
            }

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
                // ★ Perplexity 모드에서는 웨이크워드 없으면 return (TRANSCRIPT는 이미 위에서 처리됨)
                if (context.perplexityModeActive && !shouldRespond) {
                    return;
                }

                if (!shouldRespond) {
                    // ★ AI 의견 제시 체크 (검증된 근거가 있을 때만)
                    const opinionResult = await this.checkAndOfferOpinion(
                        roomId,
                        context,
                        requestId,
                        processedText,
                        userId
                    );

                    if (opinionResult) {
                        // 의견 제시됨 - 종료
                        return;
                    }

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

                // ★ AI 상태: listening (시리 UI용)
                this.broadcastAiState(roomId, 'listening', { transcript: processedText }).catch(() => {});

                // ============================================
                // 7.5 Agent 모드 판단 (패턴 매칭 실패 시 LLM 라우팅)
                // ============================================
                const useAgentMode = this.shouldUseAgentMode(processedText, intentAnalysis);

                if (useAgentMode) {
                    this.logger.log(`[Agent 모드] LLM 라우팅 시작`);
                    await this.processWithAgent(
                        context,
                        roomId,
                        requestId,
                        processedText,
                        userId,
                        startTime
                    );
                    return;
                }

                // ============================================
                // 8. 검색 키워드 준비 (기존 패턴 매칭 로직)
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

                // ★ AI 상태: processing (시리 UI용)
                this.broadcastAiState(roomId, 'processing', { transcript: processedText }).catch(() => {});

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

                // 700ms 후에도 응답 없으면 "생각중" 발화 (hostOnlyMode에서는 스킵 - Dynamic Island로 대체)
                const thinkingTask = (async () => {
                    if (context.hostOnlyMode) return; // Dynamic Island가 상태 표시
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
                // 10. DataChannel 전송 (검색 결과) - hostOnlyMode에서는 스킵
                // ============================================
                if (!context.hostOnlyMode && llmResult.searchResults && llmResult.searchResults.length > 0) {
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
                // 10-1. DataChannel 전송 (RAG 문서 출처 → AI 문서 패널)
                // ============================================
                if (llmResult.ragSources && llmResult.ragSources.length > 0) {
                    const documentMessage = {
                        type: 'AI_DOCUMENT_SHOW',
                        keyword: processedText.substring(0, 30),
                        documents: llmResult.ragSources.map((source, idx) => ({
                            id: `doc-${Date.now()}-${idx}`,
                            pageNumber: idx + 1,
                            content: source.text,
                            sourceFile: source.speaker ? `${source.speaker}의 발언` : '회의 기록',
                            relevance: `"${processedText.substring(0, 20)}..." 질문에 대한 관련 내용`,
                            highlights: [{
                                text: source.text.substring(0, 200),
                                color: '#fef08a'
                            }]
                        }))
                    };

                    const encoder = new TextEncoder();
                    await context.room.localParticipant.publishData(
                        encoder.encode(JSON.stringify(documentMessage)),
                        { reliable: true }
                    );
                    this.logger.log(`[DataChannel] AI 문서 패널 전송 (${llmResult.ragSources.length}개 출처)`);
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

                this.logger.log(`========== [완료] 총 ${Date.now() - responseStartTime}ms ==========\n`);
            }

        } catch (error) {
            this.logger.error(`[에러] ${error.message}`, error.stack);
            // 에러 시 안전하게 SLEEP 복귀
            context.botState = BotState.SLEEP;
            context.activeUserId = null;
        } finally {
            if (context.currentRequestId === requestId) {
                context.isPublishing = false;
                context.publishingStartTime = 0;
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
                audioSource.captureFrame(frames[frameIndex]).catch(() => { });
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
        // AI 음소거 상태면 TTS 스킵
        if (context.aiMuted) {
            this.logger.log(`[TTS 스킵] AI 음소거 상태 - 메시지: "${message.substring(0, 50)}..."`);
            return;
        }

        // 호스트 전용 모드면 TTS 대신 텍스트 카드 전송
        if (context.hostOnlyMode && context.hostIdentity) {
            this.logger.log(`[텍스트 카드] 호스트에게만 전송 - 메시지: "${message.substring(0, 50)}..."`);

            // Siri 스타일: speaking 상태 브로드캐스트
            await this.broadcastAiState(roomId, 'speaking', { response: message });

            await this.sendTextCardToHost(context, message);

            // 일정 시간 후 idle 상태로 복귀 (텍스트 읽는 시간 고려)
            const readingTime = Math.min(message.length * 50, 5000); // 글자당 50ms, 최대 5초
            setTimeout(() => {
                this.broadcastAiState(roomId, 'idle');
            }, readingTime);
            return;
        }

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

        // Siri 스타일: speaking 상태 브로드캐스트
        await this.broadcastAiState(roomId, 'speaking', { response: message });

        await this.publishAudio(roomId, context.audioSource, pcmAudio);

        // 오디오 재생 완료 후 idle 상태로 복귀
        await this.broadcastAiState(roomId, 'idle');
    }

    // ============================================================
    // Agent Mode Methods (지능형 라우팅)
    // ============================================================

    /**
     * Agent 모드 사용 여부 판단
     * 패턴 매칭으로 명확히 분류되지 않는 경우 LLM 라우팅 사용
     */
    private shouldUseAgentMode(
        text: string,
        intentAnalysis: ReturnType<IntentClassifierService['classify']>
    ): boolean {
        // 1. 애매한 패턴 먼저 체크 (최우선)
        // 예: "저번에 그거 어떻게 됐어?", "전에 했던 얘기 맞냐?", "뭐라고 했더라?"
        const ambiguousPatterns = [
            /전에|아까|방금|이전|지난번|저번/,  // 시간 참조 (저번 추가)
            /그거|그게|이거|저거/,               // 대명사 (뭐는 너무 광범위해서 제외)
            /했(던|었|는)|말(했|한)/,           // 과거 참조
            /뭐라고|뭐라|뭔가/,                  // 불명확한 질문
        ];

        const hasAmbiguousPattern = ambiguousPatterns.some(p => p.test(text));

        if (hasAmbiguousPattern) {
            this.logger.log(`[Agent 판단] 애매한 패턴 감지: "${text}" → Agent 모드`);
            return true;
        }

        // 2. 명확한 카테고리가 있으면 기존 로직 사용
        if (intentAnalysis.category && [
            '날씨', '맛집', '카페', '술집', '뉴스', '주식', '스포츠'
        ].includes(intentAnalysis.category)) {
            return false;
        }

        // 3. 명확한 명령어 패턴이 있으면 기존 로직 사용
        if (intentAnalysis.hasCommandWord) {
            return false;
        }

        // 4. 검색 키워드가 명확하면 기존 로직 사용
        if (intentAnalysis.extractedKeyword && intentAnalysis.extractedKeyword.length >= 3) {
            return false;
        }

        // 5. 카테고리도 없고 키워드도 없는 질문 → Agent 모드
        if (!intentAnalysis.category && !intentAnalysis.extractedKeyword) {
            this.logger.debug(`[Agent 판단] 카테고리/키워드 없음: "${text}"`);
            return true;
        }

        return false;
    }

    /**
     * Agent 모드 처리
     * LLM Function Calling으로 적절한 도구 선택 후 실행
     */
    private async processWithAgent(
        context: RoomContext,
        roomId: string,
        requestId: number,
        processedText: string,
        userId: string,
        startTime: number
    ): Promise<void> {
        try {
            // 1. 대화 히스토리 준비
            const conversationHistory = context.conversationHistory || [];

            // 2. Agent 판단 (어떤 도구를 사용할지)
            const decision = await this.agentRouter.decide(
                processedText,
                conversationHistory,
                { title: roomId }
            );

            this.logger.log(`[Agent] Tool: ${decision.tool}, Params: ${JSON.stringify(decision.params)}`);

            // 3. 도구 실행
            const toolResult = await this.agentRouter.executeTool(
                decision,
                roomId,
                processedText
            );

            // 4. 최종 응답 생성
            const response = await this.agentRouter.generateResponse(
                processedText,
                decision,
                toolResult,
                conversationHistory
            );

            if (context.currentRequestId !== requestId) {
                this.logger.log(`[Agent] 요청 취소됨 (requestId 변경)`);
                return;
            }

            // 5. 대화 히스토리 업데이트
            this.updateConversationHistory(context, processedText, response, userId);

            // 6. DataChannel 전송 (검색 결과가 있으면)
            if (toolResult.searchResults && toolResult.searchResults.length > 0) {
                const searchMessage = {
                    type: 'search_answer',
                    text: response,
                    category: decision.tool === 'search_local' ? '장소' : '검색',
                    results: toolResult.searchResults,
                };

                const encoder = new TextEncoder();
                await context.room.localParticipant.publishData(
                    encoder.encode(JSON.stringify(searchMessage)),
                    { reliable: true }
                );
                this.logger.log(`[Agent] DataChannel 전송 (${toolResult.searchResults.length}개 결과)`);
            }

            // 7. TTS 발화
            context.shouldInterrupt = false;
            context.botState = BotState.SPEAKING;
            await this.speakAndPublish(context, roomId, requestId, response);

            // 8. 응답 완료 → SLEEP
            context.botState = BotState.SLEEP;
            context.activeUserId = null;
            context.lastResponseTime = Date.now();

            this.logger.log(`[Agent 완료] 총 ${Date.now() - startTime}ms`);

        } catch (error) {
            this.logger.error(`[Agent 에러] ${error.message}`, error.stack);
            // 에러 시 간단한 응답
            context.botState = BotState.SPEAKING;
            await this.speakAndPublish(context, roomId, requestId, '죄송해요, 잠시 문제가 생겼어요.');
            context.botState = BotState.SLEEP;
            context.activeUserId = null;
        }
    }

    /**
     * 대화 히스토리 업데이트
     */
    private updateConversationHistory(
        context: RoomContext,
        userMessage: string,
        botResponse: string,
        userId: string
    ): void {
        const now = Date.now();

        // 오래된 대화 제거 (5분 이상)
        context.conversationHistory = context.conversationHistory.filter(
            turn => now - turn.timestamp < this.CONVERSATION_EXPIRE_MS
        );

        // 의미 있는 발화만 저장 (추임새, 빈 텍스트 필터링)
        const cleanedUserMessage = this.cleanForHistory(userMessage);
        const cleanedBotResponse = this.cleanForHistory(botResponse);

        // 사용자 발화가 의미있으면 추가
        if (cleanedUserMessage && cleanedUserMessage.length >= 3) {
            context.conversationHistory.push({
                role: 'user',
                content: cleanedUserMessage,
                timestamp: now,
                speaker: userId,
            });
        } else {
            this.logger.debug(`[대화 히스토리] 사용자 발화 스킵 (짧거나 추임새): "${userMessage}"`);
        }

        // 봇 응답이 의미있으면 추가
        if (cleanedBotResponse && cleanedBotResponse.length >= 3) {
            context.conversationHistory.push({
                role: 'assistant',
                content: cleanedBotResponse,
                timestamp: now,
            });
        }

        // 최대 턴 수 유지
        if (context.conversationHistory.length > this.MAX_CONVERSATION_TURNS * 2) {
            context.conversationHistory = context.conversationHistory.slice(-this.MAX_CONVERSATION_TURNS * 2);
        }

        this.logger.debug(`[대화 히스토리] ${context.conversationHistory.length}턴 저장`);
    }

    /**
     * 히스토리 저장용 텍스트 정제
     * 추임새, 빈 텍스트, 웨이크워드만 있는 발화 필터링
     */
    private cleanForHistory(text: string): string {
        if (!text) return '';

        // 1. 웨이크워드 제거
        let cleaned = text
            .replace(/^(아우라야?|헤이\s*아우라|오케이\s*아우라)\s*/gi, '')
            .trim();

        // 2. 추임새만 있는지 체크
        const fillerPatterns = [
            /^(음+|어+|아+|으+|에+|응+|네+|예+|야+)[\.\?\!]*$/,  // 단독 추임새
            /^(음+|어+|아+|으+)[\s\.\,]*$/,                      // 추임새 + 공백/구두점
            /^(그+|저+|이+)[\s\.\,]*$/,                          // 지시사만
            /^[\.\?\!\,\s]+$/,                                   // 구두점만
        ];

        for (const pattern of fillerPatterns) {
            if (pattern.test(cleaned)) {
                return '';  // 추임새만 있으면 빈 문자열 반환
            }
        }

        return cleaned;
    }

    /**
     * [DEBUG] 오디오를 WAV 파일로 저장 (품질 확인용)
     * 환경변수 DEBUG_SAVE_AUDIO=true 설정 시 활성화
     * 저장 위치: ./debug_audio/
     */
    private saveDebugAudio(audioBuffer: Buffer, roomId: string): void {
        try {
            const debugDir = path.join(process.cwd(), 'debug_audio');
            if (!fs.existsSync(debugDir)) {
                fs.mkdirSync(debugDir, { recursive: true });
            }

            const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
            const filename = `${roomId}_${timestamp}.wav`;
            const filepath = path.join(debugDir, filename);

            // WAV 헤더 생성 (16kHz, 16bit, mono)
            const wavHeader = this.createWavHeader(audioBuffer.length, 16000, 1, 16);
            const wavBuffer = Buffer.concat([wavHeader, audioBuffer]);

            fs.writeFileSync(filepath, wavBuffer);
            this.logger.log(`[DEBUG] 오디오 저장: ${filename} (${audioBuffer.length} bytes)`);
        } catch (err) {
            this.logger.error(`[DEBUG] 오디오 저장 실패: ${err.message}`);
        }
    }

    /**
     * WAV 파일 헤더 생성
     */
    private createWavHeader(dataLength: number, sampleRate: number, channels: number, bitsPerSample: number): Buffer {
        const header = Buffer.alloc(44);
        const byteRate = sampleRate * channels * (bitsPerSample / 8);
        const blockAlign = channels * (bitsPerSample / 8);

        // RIFF header
        header.write('RIFF', 0);
        header.writeUInt32LE(36 + dataLength, 4);
        header.write('WAVE', 8);

        // fmt subchunk
        header.write('fmt ', 12);
        header.writeUInt32LE(16, 16);           // Subchunk1Size (16 for PCM)
        header.writeUInt16LE(1, 20);            // AudioFormat (1 = PCM)
        header.writeUInt16LE(channels, 22);     // NumChannels
        header.writeUInt32LE(sampleRate, 24);   // SampleRate
        header.writeUInt32LE(byteRate, 28);     // ByteRate
        header.writeUInt16LE(blockAlign, 32);   // BlockAlign
        header.writeUInt16LE(bitsPerSample, 34);// BitsPerSample

        // data subchunk
        header.write('data', 36);
        header.writeUInt32LE(dataLength, 40);

        return header;
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

    // 봇만 종료 (요약할 때 사용 - cleanup 안 함)
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

    // 봇 종료 + cleanup (참여자 없을 때 자동 종료 시 사용)
    async stopBotWithCleanup(roomId: string): Promise<void> {
        await this.stopBot(roomId);

        // LiveKit 룸 삭제
        try {
            await this.livekitService.deleteRoom(roomId);
            this.logger.log(`[LiveKit 룸 삭제 완료] ${roomId}`);
        } catch (error) {
            this.logger.error(`[LiveKit 룸 삭제 실패] ${roomId}: ${error.message}`);
        }

        // REST API 호출하여 Room, RoomReport, File 삭제
        await this.cleanupRoomInDatabase(roomId);
        this.logger.log(`[봇 종료 + DB 정리] ${roomId}`);
    }

    private async cleanupRoomInDatabase(roomId: string): Promise<void> {
        try {
            const axios = await import('axios');
            const backendUrl = process.env.BACKEND_API_URL || 'http://backend:3002';
            const response = await axios.default.post(
                `${backendUrl}/restapi/internal/room-cleanup`,
                { roomId },
                { timeout: 5000 }
            );
            this.logger.log(`[DB 정리 완료] roomId: ${roomId}, result: ${JSON.stringify(response.data)}`);
        } catch (error) {
            this.logger.error(`[DB 정리 실패] roomId: ${roomId}, error: ${error.message}`);
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
        context.publishingStartTime = Date.now();

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

            // "잠깐만요" 먼저 말하기 (Vision API 호출 시간 벌기) - hostOnlyMode에서는 스킵
            if (!context.hostOnlyMode) {
                const thinkingPhrases = [
                    '잠깐 볼게요~',
                    '한번 볼게요',
                    '잠깐만요~',
                ];
                const thinkingPhrase = thinkingPhrases[Math.floor(Math.random() * thinkingPhrases.length)];
                await this.speakAndPublish(context, roomId, requestId, thinkingPhrase);
            }

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
            context.publishingStartTime = 0;
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
    // 설계 모드 - 다이어그램 자동 설명
    // ============================================================

    /**
     * 생성된 다이어그램 자동 설명
     * 설계 보드가 열리고 다이어그램이 생성되면 자동으로 TTS로 설명
     */
    private async explainGeneratedDiagrams(
        roomId: string,
        types: string[],
        mermaidCodes: Record<string, string>
    ): Promise<void> {
        const context = this.activeRooms.get(roomId);
        if (!context || !context.designModeActive) {
            this.logger.log(`[설계 모드] 자동 설명 스킵 - 설계 모드 비활성`);
            return;
        }

        if (context.isPublishing) {
            this.logger.log(`[설계 모드] 자동 설명 스킵 - 이미 발화 중`);
            return;
        }

        const requestId = Date.now();
        context.currentRequestId = requestId;

        this.logger.log(`[설계 모드] 다이어그램 자동 설명 시작 - ${types.join(', ')}`);

        try {
            context.isPublishing = true;
            context.publishingStartTime = Date.now();
            context.botState = BotState.SPEAKING;

            // 각 다이어그램 타입에 대한 간단한 설명 생성
            const typeLabels: Record<string, string> = {
                flowchart: '플로우차트',
                erd: 'ERD',
                sequence: '시퀀스 다이어그램',
                architecture: '아키텍처 다이어그램',
            };

            const generatedTypes = types.map(t => typeLabels[t] || t).join(', ');

            // 첫 번째 다이어그램에 대해 간단한 설명 생성
            let explanation = '';
            const firstType = types[0];
            const firstCode = mermaidCodes[firstType];

            if (firstCode && firstCode.length > 0) {
                // LLM을 사용해 다이어그램 내용 분석
                const prompt = `다음 ${typeLabels[firstType] || firstType} 다이어그램을 2문장으로 아주 간결하게 설명해주세요. 기술적인 내용 위주로 말해주세요.

다이어그램 코드:
${firstCode.substring(0, 500)}

설명:`;

                explanation = await this.llmService.sendMessagePure(prompt, 150);
            }

            // TTS로 안내
            let message = `회의 내용을 분석해서 ${generatedTypes}를 생성했어요.`;
            if (explanation && explanation.trim()) {
                message += ` ${explanation.trim()}`;
            }
            message += ` 다이어그램에 대해 더 궁금한 게 있으시면 질문해주세요.`;

            await this.speakAndPublish(context, roomId, requestId, message);

            context.botState = BotState.ARMED;
            context.lastResponseTime = Date.now();

            this.logger.log(`[설계 모드] 자동 설명 완료`);
        } catch (error) {
            this.logger.error(`[설계 모드] 자동 설명 실패: ${error.message}`);
        } finally {
            context.isPublishing = false;
            context.publishingStartTime = 0;
        }
    }

    /**
     * 다이어그램 관련 질문인지 판단
     */
    private isDiagramRelatedQuestion(transcript: string): boolean {
        const diagramKeywords = [
            // 다이어그램 타입
            '플로우차트', 'flowchart', '흐름도', '순서도',
            'erd', '이알디', '엔티티', '테이블', '데이터베이스', 'db',
            '시퀀스', 'sequence', '상호작용',
            '아키텍처', 'architecture', '구조',
            // 다이어그램 관련 질문
            '다이어그램', '차트', '그림', '도표', '도식',
            '설계', '모델', '스키마', '관계',
            // 다이어그램 동작
            '설명', '분석', '의미', '뜻', '내용',
            '노드', '엣지', '연결', '화살표', '박스',
            '프로세스', '단계', '흐름', '분기',
            // 수정/편집 관련
            '수정', '변경', '추가', '삭제', '편집',
            // 질문 패턴
            '이게 뭐야', '뭘 의미', '어떤 의미', '왜 이렇게',
        ];

        const normalizedTranscript = transcript.toLowerCase();
        return diagramKeywords.some(keyword =>
            normalizedTranscript.includes(keyword.toLowerCase())
        );
    }

    // ============================================================
    // 타임라인 키워드 추출 (30초 단위, 5초마다 갱신)
    // ============================================================

    /**
     * 현재 30초 구간 인덱스 계산
     */
    private getCurrentMinuteIndex(roomId: string): number {
        const context = this.activeRooms.get(roomId);
        if (!context?.timelineStartTime) return 0;
        const elapsed = Date.now() - context.timelineStartTime;
        return Math.floor(elapsed / 30000); // 30초 = 0.5분
    }

    /**
     * 타임라인 5초 인터벌 시작
     */
    private startTimelineInterval(roomId: string): void {
        const context = this.activeRooms.get(roomId);
        if (!context) return;

        // 기존 인터벌 정리
        if (context.timelineInterval) {
            clearInterval(context.timelineInterval);
        }

        // 5초마다 키워드 추출 및 전송
        context.timelineInterval = setInterval(async () => {
            await this.flushTimelineKeywords(roomId);
        }, 5000);

        this.logger.log(`[Timeline] 5초 인터벌 시작 - roomId: ${roomId}`);
    }

    /**
     * 타임라인 인터벌 정지
     */
    private stopTimelineInterval(roomId: string): void {
        const context = this.activeRooms.get(roomId);
        if (context?.timelineInterval) {
            clearInterval(context.timelineInterval);
            context.timelineInterval = undefined;
            this.logger.log(`[Timeline] 인터벌 정지 - roomId: ${roomId}`);
        }
    }

    /**
     * STT 발화를 수집 (키워드 추출은 5초마다 일괄 처리)
     */
    private collectTranscriptForTimeline(
        roomId: string,
        transcript: string,
        speaker: string
    ): void {
        const context = this.activeRooms.get(roomId);
        if (!context) return;

        // 너무 짧은 텍스트는 스킵
        if (transcript.trim().length <= 3) return;

        const currentMinute = this.getCurrentMinuteIndex(roomId);

        // 새로운 분이 시작되면 이전 발화 초기화
        if (currentMinute !== context.lastTimelineMinuteIndex) {
            context.pendingTranscripts = [];
            context.lastTimelineMinuteIndex = currentMinute;
            this.logger.log(`[Timeline] 새 분 시작: ${currentMinute}`);
        }

        // 발화 수집
        context.pendingTranscripts.push({
            speaker,
            text: transcript.trim(),
            timestamp: Date.now(),
        });
    }

    /**
     * 수집된 발화에서 핵심 키워드 추출 후 전송 (5초마다 호출)
     * - 발화자별로 그룹화하여 각각 키워드 5개씩 추출
     */
    private async flushTimelineKeywords(roomId: string): Promise<void> {
        const context = this.activeRooms.get(roomId);
        if (!context || context.pendingTranscripts.length === 0) return;

        const minuteIndex = this.getCurrentMinuteIndex(roomId);

        // 발화자별로 그룹화
        const speakerTranscripts = new Map<string, string[]>();
        for (const t of context.pendingTranscripts) {
            const texts = speakerTranscripts.get(t.speaker) || [];
            texts.push(t.text);
            speakerTranscripts.set(t.speaker, texts);
        }

        try {
            // 발화자별로 키워드 추출 (병렬 처리)
            const speakerKeywordsPromises = Array.from(speakerTranscripts.entries()).map(
                async ([speaker, texts]) => {
                    const allText = texts.join(' ');
                    const keywords = await this.extractKeywordsWithLLM(allText);
                    return { speaker, keywords };
                }
            );

            const speakerKeywordsResults = await Promise.all(speakerKeywordsPromises);

            // 키워드가 하나도 없으면 스킵
            const validResults = speakerKeywordsResults.filter(r => r.keywords.length > 0);
            if (validResults.length === 0) return;

            // 발화자별 키워드 객체 생성
            const speakerKeywords: Record<string, string[]> = {};
            for (const { speaker, keywords } of validResults) {
                speakerKeywords[speaker] = keywords;
            }

            const message = {
                type: 'TIMELINE_KEYWORDS_UPDATE',
                speakerKeywords, // { "발화자1": ["키워드1", ...], "발화자2": ["키워드1", ...] }
                minuteIndex,
                timestamp: Date.now(),
                roomId,
            };

            const encoder = new TextEncoder();
            await context.room.localParticipant.publishData(
                encoder.encode(JSON.stringify(message)),
                { reliable: true }
            );

            const logSummary = validResults.map(r => `${r.speaker}: [${r.keywords.join(', ')}]`).join(' | ');
            this.logger.log(`[Timeline] 키워드 갱신 (minute: ${minuteIndex}) - ${logSummary}`);

            // 전송 후 발화 초기화 (이전 키워드가 반복되지 않도록)
            context.pendingTranscripts = [];
        } catch (error) {
            this.logger.error(`[Timeline] 키워드 추출 실패: ${error.message}`);
        }
    }

    /**
     * LLM으로 핵심 키워드 최대 5개 추출
     */
    private async extractKeywordsWithLLM(transcripts: string): Promise<string[]> {
        const prompt = `다음 대화에서 핵심 키워드를 최대 5개 추출하세요.

규칙:
- 명사 또는 명사구만 추출
- 의미 없는 추임새나 감탄사만 제외 (예: 네, 아, 음, 어)
- 대화에서 언급된 주요 토픽이나 주제어 추출
- 중복 키워드 제외
- 키워드가 없으면 빈 줄 출력
- 각 키워드를 한 줄에 하나씩 출력 (번호나 설명 없이)

발화 내용:
${transcripts}

핵심 키워드:`;

        const result = await this.llmService.sendMessagePure(prompt, 100);

        // 결과 파싱: 줄바꿈으로 분리하고 정리
        const keywords = result
            .split('\n')
            .map(line => line.trim().replace(/^[-•*\d.)\s]+/, '').trim())
            .filter(kw =>
                kw.length >= 2 &&
                kw.length <= 20 &&  // 너무 긴 문장 제외
                kw !== 'NONE' &&
                !kw.includes(':') &&
                !kw.includes('키워드') &&  // 설명 문구 제외
                !kw.includes('추출') &&
                !kw.includes('불가능') &&
                !kw.includes('없습니다') &&
                !kw.includes('명사')
            )
            .slice(0, 5);

        return keywords;
    }

    // ============================================================
    // RAG 임베딩 전송 (회의록용)
    // ============================================================

    /**
     * STT 결과를 RAG 서버로 전송 (임베딩용)
     * - 비동기, 논블로킹 (fire-and-forget)
     * - 짧은 추임새나 무의미한 텍스트는 필터링
     * @param startTime 발언 시작 시간 (동시발화 순서 보장용)
     * @param endTime 발언 종료 시간 (타임라인용, Clova STT에서 제공)
     */
    private sendToRagForEmbedding(roomId: string, text: string, speaker: string, startTime: number | null = null, endTime: number | null = null): void {
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
        this.ragClient.sendStatement(roomId, text, speaker, startTime, endTime)
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
     * AI 의견 제시 체크 및 발화
     * 검증된 근거(Evidence)가 있을 때만 의견 제시
     *
     * @returns true if opinion was offered, false otherwise
     */
    private async checkAndOfferOpinion(
        roomId: string,
        context: RoomContext,
        requestId: number,
        currentText: string,
        userId: string,
    ): Promise<boolean> {
        // 의견 제시 비활성화 확인
        if (!this.opinionService.isEnabled()) {
            return false;
        }

        // 최근 대화 히스토리를 컨텍스트로 사용
        const conversationContext = this.buildConversationContext(context.conversationHistory, currentText);

        // 텍스트가 너무 짧으면 스킵
        if (conversationContext.length < 20) {
            return false;
        }

        try {
            const result = await this.opinionService.analyzeAndRespond(
                roomId,
                conversationContext,
                userId,
            );

            if (!result.shouldSpeak || !result.response) {
                this.logger.debug(`[AI 의견] 제시 조건 미충족: ${result.silenceReason || 'unknown'}`);
                return false;
            }

            this.logger.log(`[AI 의견 제시] 신뢰도: ${result.confidence}%, 토픽: ${result.evidence?.topic}`);

            // 의견 제시 발화
            context.botState = BotState.SPEAKING;
            await this.speakAndPublish(context, roomId, requestId, result.response);
            context.botState = BotState.SLEEP;  // 의견 제시 후 다시 SLEEP으로
            context.lastResponseTime = Date.now();

            // DataChannel로 Evidence 정보 전송 (UI에서 출처 링크 표시용)
            if (result.evidence) {
                const evidenceMessage = this.opinionService.formatForDataChannel(result.evidence);
                const encoder = new TextEncoder();
                await context.room.localParticipant.publishData(
                    encoder.encode(JSON.stringify(evidenceMessage)),
                    { reliable: true }
                );
                this.logger.log(`[DataChannel] Evidence 정보 전송: ${result.evidence.sourceName}`);
            }

            return true;
        } catch (error) {
            this.logger.error(`[AI 의견] 에러: ${error.message}`);
            return false;
        }
    }

    /**
     * 대화 히스토리를 텍스트로 변환
     */
    private buildConversationContext(history: ConversationTurn[], currentText: string): string {
        // 최근 5턴의 대화를 컨텍스트로 사용
        const recentHistory = history.slice(-5);

        let context = '';
        for (const turn of recentHistory) {
            const role = turn.role === 'user' ? '참여자' : '아우라';
            context += `${role}: ${turn.content}\n`;
        }

        // 현재 발화 추가
        context += `참여자: ${currentText}`;

        return context;
    }

    /**
     * 활성 방 목록 조회 (디버깅용)
     */
    getActiveRoomIds(): string[] {
        return Array.from(this.activeRooms.keys());
    }

    // ============================================================
    // 호스트 전용 코칭 모드 메서드
    // ============================================================

    /**
     * 호스트에게만 텍스트 카드 전송 (TTS 대체)
     */
    private async sendTextCardToHost(context: RoomContext, message: string): Promise<void> {
        if (!context.hostIdentity) return;

        const textCardMessage = {
            type: 'AI_TEXT_RESPONSE',
            text: message,
            timestamp: Date.now(),
        };

        const encoder = new TextEncoder();

        // 호스트에게만 전송
        await context.room.localParticipant.publishData(
            encoder.encode(JSON.stringify(textCardMessage)),
            {
                reliable: true,
                destination_identities: [context.hostIdentity]
            }
        );

        this.logger.log(`[텍스트 카드] 호스트에게 전송 완료`);
    }

    /**
     * 호스트 AI 쿼리 처리 (Wake word 대체)
     */
    private async processHostQuery(roomId: string, query: string, hostIdentity: string): Promise<void> {
        const context = this.activeRooms.get(roomId);
        if (!context) return;

        try {
            // RAG 검색
            const ragAnswer = await this.ragClient.sendQuestion(roomId, query);

            if (ragAnswer) {
                await this.sendTextCardToHost(context, ragAnswer);
            } else {
                // RAG 결과 없으면 LLM 직접 호출
                const prompt = `질문: ${query}\n\n간결하고 명확하게 한국어로 답변해주세요.`;
                const llmResponse = await this.llmService.sendMessagePure(prompt, 500);
                await this.sendTextCardToHost(context, llmResponse);
            }

            // 대화 히스토리에 추가
            context.conversationHistory.push({
                role: 'user',
                content: query,
                timestamp: Date.now(),
                speaker: hostIdentity,
            });
        } catch (error) {
            this.logger.error(`[호스트 쿼리] 에러: ${error.message}`);
            await this.sendTextCardToHost(context, '죄송해요, 잠시 문제가 생겼어요.');
        }
    }

    /**
     * Silent Participant 주기적 체크 시작
     */
    private startSilentParticipantChecker(roomId: string): void {
        const SILENT_THRESHOLD_MS = 2* 60 * 1000; // 2분
        const CHECK_INTERVAL_MS = 15 * 1000; // 15초마다 체크
        const alreadyAlerted = new Set<string>(); // 이미 알린 참여자

        const initialContext = this.activeRooms.get(roomId);
        if (!initialContext) return;

        // 참여자 입장 시간 기록 (한 번도 발언 안 한 참여자 감지용)
        const participantJoinTime = new Map<string, number>();

        const checkInterval = setInterval(async () => {
            const context = this.activeRooms.get(roomId);
            if (!context) {
                clearInterval(checkInterval);
                return;
            }

            // 호스트 전용 모드가 아니면 스킵
            if (!context.hostOnlyMode || !context.hostIdentity) {
                return;
            }

            const now = Date.now();

            // 현재 방의 모든 참여자 확인
            for (const participant of context.room.remoteParticipants.values()) {
                const identity = participant.identity;

                // AI 봇이나 호스트는 제외
                if (identity.startsWith('ai-bot') || identity === context.hostIdentity) {
                    continue;
                }

                // 참여자 입장 시간 기록 (처음 본 경우)
                if (!participantJoinTime.has(identity)) {
                    participantJoinTime.set(identity, now);
                }

                const lastSttTime = context.lastSttTimeByUser.get(identity) || 0;
                const joinTime = participantJoinTime.get(identity) || now;

                // 마지막 발언 시간 또는 입장 시간 기준
                const referenceTime = lastSttTime > 0 ? lastSttTime : joinTime;
                const silentDuration = now - referenceTime;

                // 3분 이상 발언 없고, 아직 알리지 않은 경우
                if (silentDuration >= SILENT_THRESHOLD_MS && !alreadyAlerted.has(identity)) {
                    const participantName = participant.name || identity;
                    await this.sendSilentParticipantAlert(roomId, identity, participantName, silentDuration);
                    alreadyAlerted.add(identity);
                    this.logger.log(`[Silent 감지] ${participantName} - ${Math.floor(silentDuration / 60000)}분 동안 발언 없음`);
                }

                // 발언하면 알림 리셋
                if (lastSttTime > 0 && (now - lastSttTime) < SILENT_THRESHOLD_MS) {
                    alreadyAlerted.delete(identity);
                }
            }
        }, CHECK_INTERVAL_MS);

        // 방 종료 시 정리
        const cleanup = () => {
            clearInterval(checkInterval);
        };

        initialContext.room.on(RoomEvent.Disconnected, cleanup);
    }

    /**
     * Silent Participant 알림 전송 (호스트에게만)
     */
    async sendSilentParticipantAlert(
        roomId: string,
        participantId: string,
        participantName: string,
        silentDurationMs: number
    ): Promise<void> {
        const context = this.activeRooms.get(roomId);
        if (!context || !context.hostOnlyMode || !context.hostIdentity) return;

        const alertMessage = {
            type: 'SILENT_PARTICIPANT_ALERT',
            participantId,
            participantName,
            silentDurationMs,
            silentMinutes: Math.floor(silentDurationMs / 60000),
            timestamp: Date.now(),
        };

        const encoder = new TextEncoder();

        await context.room.localParticipant.publishData(
            encoder.encode(JSON.stringify(alertMessage)),
            {
                reliable: true,
                destination_identities: [context.hostIdentity]
            }
        );

        this.logger.log(`[Silent 알림] ${participantName} (${Math.floor(silentDurationMs / 60000)}분) → 호스트에게 전송`);
    }

    /**
     * 참여자 발언 통계 업데이트
     */
    private updateParticipantSpeakingStats(
        context: RoomContext,
        participantId: string,
        participantName: string,
        durationMs: number
    ): void {
        const existing = context.participantSpeakingStats.get(participantId);

        if (existing) {
            existing.speakingDurationMs += durationMs;
            existing.speakingCount += 1;
            existing.lastSpokenAt = Date.now();
        } else {
            context.participantSpeakingStats.set(participantId, {
                participantId,
                participantName,
                speakingDurationMs: durationMs,
                speakingCount: 1,
                lastSpokenAt: Date.now(),
            });
        }
    }

    /**
     * 발언 통계 주기적 전송 시작 (호스트에게 실시간 발언 분포 전송)
     */
    private startSpeakingStatsChecker(roomId: string): void {
        const STATS_INTERVAL_MS = 10 * 1000; // 10초마다
        const DOMINANT_THRESHOLD = 0.6; // 60% 이상이면 dominant

        const initialContext = this.activeRooms.get(roomId);
        if (!initialContext) return;

        const statsInterval = setInterval(async () => {
            const context = this.activeRooms.get(roomId);
            if (!context) {
                clearInterval(statsInterval);
                return;
            }

            // 호스트 전용 모드가 아니면 스킵
            if (!context.hostOnlyMode || !context.hostIdentity) {
                return;
            }

            // 발언 데이터가 없으면 스킵
            if (context.participantSpeakingStats.size === 0) {
                return;
            }

            // 전체 발언 시간 계산
            let totalDurationMs = 0;
            const statsArray: Array<{
                participantId: string;
                participantName: string;
                speakingDurationMs: number;
                speakingCount: number;
                speakingRatio: number;
            }> = [];

            for (const stats of context.participantSpeakingStats.values()) {
                totalDurationMs += stats.speakingDurationMs;
            }

            // 비율 계산
            for (const stats of context.participantSpeakingStats.values()) {
                const ratio = totalDurationMs > 0 ? stats.speakingDurationMs / totalDurationMs : 0;
                statsArray.push({
                    participantId: stats.participantId,
                    participantName: stats.participantName,
                    speakingDurationMs: stats.speakingDurationMs,
                    speakingCount: stats.speakingCount,
                    speakingRatio: Math.round(ratio * 100) / 100,
                });
            }

            // 발언 시간 순으로 정렬
            statsArray.sort((a, b) => b.speakingDurationMs - a.speakingDurationMs);

            // 호스트에게 통계 전송
            const statsMessage = {
                type: 'PARTICIPANT_STATS',
                stats: statsArray,
                totalDurationMs,
                timestamp: Date.now(),
            };

            const encoder = new TextEncoder();

            try {
                await context.room.localParticipant.publishData(
                    encoder.encode(JSON.stringify(statsMessage)),
                    {
                        reliable: true,
                        destination_identities: [context.hostIdentity]
                    }
                );

                // Dominant speaker 체크 (60% 이상, 2명 이상 참여자)
                if (statsArray.length >= 2 && !context.dominantAlertSent) {
                    const topSpeaker = statsArray[0];
                    if (topSpeaker.speakingRatio >= DOMINANT_THRESHOLD) {
                        // Dominant 알림 전송
                        const dominantAlert = {
                            type: 'DOMINANT_SPEAKER_ALERT',
                            participantId: topSpeaker.participantId,
                            participantName: topSpeaker.participantName,
                            speakingRatio: topSpeaker.speakingRatio,
                            timestamp: Date.now(),
                        };

                        await context.room.localParticipant.publishData(
                            encoder.encode(JSON.stringify(dominantAlert)),
                            {
                                reliable: true,
                                destination_identities: [context.hostIdentity]
                            }
                        );

                        context.dominantAlertSent = true;
                        this.logger.log(`[Dominant 알림] ${topSpeaker.participantName} (${Math.round(topSpeaker.speakingRatio * 100)}%) → 호스트에게 전송`);
                    }
                }

                // 비율이 60% 미만으로 떨어지면 다시 알림 가능
                if (statsArray.length >= 2 && context.dominantAlertSent) {
                    const topSpeaker = statsArray[0];
                    if (topSpeaker.speakingRatio < DOMINANT_THRESHOLD - 0.1) { // 50% 미만이면 리셋
                        context.dominantAlertSent = false;
                    }
                }

            } catch (error) {
                this.logger.debug(`[발언 통계] 전송 실패: ${error.message}`);
            }

        }, STATS_INTERVAL_MS);

        // 인터벌 참조 저장 (cleanup용)
        initialContext.statsUpdateInterval = statsInterval;
    }

    /**
     * 논점 요약 주기적 체크 시작 (호스트에게 실시간 논점 전송)
     * RAG 서버의 중간 보고서를 활용
     */
    private startTopicSummaryChecker(roomId: string): void {
        const SUMMARY_INTERVAL_MS = 30 * 1000; // 30초마다
        let lastReportHash = '';

        const initialContext = this.activeRooms.get(roomId);
        if (!initialContext) return;

        const summaryInterval = setInterval(async () => {
            const context = this.activeRooms.get(roomId);
            if (!context) {
                clearInterval(summaryInterval);
                return;
            }

            // 호스트 전용 모드가 아니면 스킵
            if (!context.hostOnlyMode || !context.hostIdentity) {
                return;
            }

            try {
                // RAG 서버에서 중간 보고서 요청
                const reportResult = await this.ragClient.requestReport(roomId);

                if (!reportResult.success || !reportResult.report?.reportContent) {
                    this.logger.debug(`[논점 요약] RAG 보고서 없음 또는 실패`);
                    return;
                }

                const reportContent = reportResult.report.reportContent;

                // 동일한 보고서 중복 전송 방지
                const reportHash = reportContent.substring(0, 100);
                if (reportHash === lastReportHash) {
                    return;
                }
                lastReportHash = reportHash;

                // LLM으로 논점 추출
                const prompt = `다음 회의 중간 보고서에서 핵심 논점 1개를 추출하세요.

보고서:
${reportContent.substring(0, 1000)}

응답 형식 (JSON만, 다른 텍스트 없이):
{"topic": "논점 제목 (5단어 이내)", "summary": "핵심 내용 요약 (1-2문장)"}`;

                const response = await this.llmService.sendMessagePure(prompt, 200);

                // JSON 파싱 시도
                const jsonMatch = response.match(/\{[\s\S]*?\}/);
                if (jsonMatch) {
                    const parsed = JSON.parse(jsonMatch[0]);
                    if (parsed.topic && parsed.summary) {
                        await this.sendTopicSummary(roomId, parsed.topic, parsed.summary);
                        this.logger.log(`[논점 요약] RAG 기반 - "${parsed.topic}"`);
                    }
                }
            } catch (error) {
                this.logger.debug(`[논점 요약] 에러: ${error.message}`);
            }
        }, SUMMARY_INTERVAL_MS);

        // 방 종료 시 정리
        const cleanup = () => {
            clearInterval(summaryInterval);
        };

        initialContext.room.on(RoomEvent.Disconnected, cleanup);
    }

    /**
     * 논점 요약 전송 (호스트에게만)
     */
    async sendTopicSummary(
        roomId: string,
        topic: string,
        summary: string
    ): Promise<void> {
        const context = this.activeRooms.get(roomId);
        if (!context || !context.hostOnlyMode || !context.hostIdentity) return;

        const topicMessage = {
            type: 'TOPIC_SUMMARY',
            topic,
            summary,
            timestamp: Date.now(),
        };

        const encoder = new TextEncoder();

        await context.room.localParticipant.publishData(
            encoder.encode(JSON.stringify(topicMessage)),
            {
                reliable: true,
                destination_identities: [context.hostIdentity]
            }
        );

        this.logger.log(`[논점 요약] "${topic}" → 호스트에게 전송`);
    }

    /**
     * AI 상태 브로드캐스트 (시리 스타일 UI용)
     * state: 'idle' | 'listening' | 'processing' | 'speaking'
     */
    async broadcastAiState(
        roomId: string,
        state: 'idle' | 'listening' | 'processing' | 'speaking',
        data?: { transcript?: string; response?: string }
    ): Promise<void> {
        const context = this.activeRooms.get(roomId);
        if (!context) return;

        const stateMessage = {
            type: 'AI_STATE',
            state,
            transcript: data?.transcript,
            response: data?.response,
            timestamp: Date.now(),
        };

        const encoder = new TextEncoder();

        // 모든 참여자에게 브로드캐스트 (시리 UI는 모두에게 보임)
        await context.room.localParticipant.publishData(
            encoder.encode(JSON.stringify(stateMessage)),
            { reliable: true }
        );

        this.logger.debug(`[AI 상태] ${state}`);
    }
}