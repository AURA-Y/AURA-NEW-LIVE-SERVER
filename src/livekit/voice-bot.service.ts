import { Injectable, Logger } from '@nestjs/common';
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
import { RagClientService } from '../rag/rag-client.service';
import { IntentClassifierService } from '../intent/intent-classifier.service';

enum BotState {
    SLEEP = 'SLEEP',
    ARMED = 'ARMED',
    SPEAKING = 'SPEAKING'
}

interface MeetingContext {
    topic: string | null;                    // 회의 주제
    recentTranscripts: TranscriptEntry[];    // 최근 대화 내용
    discussedTopics: string[];               // 논의된 주제들
    lastProactiveTime: number;               // 마지막 능동적 개입 시간
    proactiveCount: number;                  // 능동적 개입 횟수 (너무 많이 안 하도록)
}

interface TranscriptEntry {
    userId: string;
    text: string;
    timestamp: number;
    category?: string | null;
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
    lastSttTime: number;
    lastResponseTime: number;
    speakingStartTime: number;
    activeUserId: string | null;
    // 능동적 개입을 위한 추가 필드
    meetingContext: MeetingContext;
    lastSpeechTime: number;                  // 마지막 발화 시간 (누구든)
    proactiveTimer: NodeJS.Timeout | null;   // 능동적 개입 타이머
}

@Injectable()
export class VoiceBotService {
    private readonly logger = new Logger(VoiceBotService.name);
    private activeRooms: Map<string, RoomContext> = new Map();

    private readonly STOP_WORDS = ['멈춰', '그만', '스톱', '중지'];
    private readonly ARMED_TIMEOUT_MS = 30000;

    // 능동적 개입 설정
    private readonly PROACTIVE_SILENCE_THRESHOLD_MS = 20_000;  // 20초 침묵
    private readonly PROACTIVE_MIN_TRANSCRIPTS = 3;            // 최소 3개 대화 필요
    private readonly PROACTIVE_MAX_PER_MEETING = 5;            // 회의당 최대 5회
    private readonly PROACTIVE_COOLDOWN_MS = 60_000;           // 개입 후 1분 쿨다운
    private readonly MAX_RECENT_TRANSCRIPTS = 15;              // 최근 15개 대화 저장

    // 동시 실행 방지 락
    private processingLock: Map<string, boolean> = new Map();

    constructor(
        private configService: ConfigService,
        private sttService: SttService,
        private llmService: LlmService,
        private ttsService: TtsService,
        private ragClientService: RagClientService,
        private intentClassifier: IntentClassifierService,
    ) { }

    async startBot(roomName: string, botToken: string): Promise<void> {
        if (this.activeRooms.has(roomName)) {
            this.logger.warn(`Bot already active in room: ${roomName}`);
            return;
        }

        const room = new Room();
        const rawUrl = this.configService.get<string>('LIVEKIT_URL');
        const livekitUrl = rawUrl.replace('http://', 'ws://').replace('https://', 'wss://');

        this.logger.log(`\n========== [AI 봇 시작] ==========`);
        this.logger.log(`방: ${roomName}, URL: ${livekitUrl}`);

        room.on(RoomEvent.TrackSubscribed, async (track: RemoteTrack, publication: RemoteTrackPublication, participant: RemoteParticipant) => {
            if (track.kind === TrackKind.KIND_AUDIO && !participant.identity.startsWith('ai-bot')) {
                this.logger.log(`[오디오 트랙 구독] ${participant.identity}`);
                await this.handleAudioTrack(roomName, track, participant.identity);
            }
        });

        room.on(RoomEvent.ParticipantConnected, (participant: RemoteParticipant) => {
            this.logger.log(`[참여자 입장] ${participant.identity}`);
        });

        room.on(RoomEvent.ParticipantDisconnected, (participant: RemoteParticipant) => {
            this.logger.log(`[참여자 퇴장] ${participant.identity}`);

            const humanCount = Array.from(room.remoteParticipants.values())
                .filter(p => !p.identity.startsWith('ai-bot')).length;

            if (humanCount === 0) {
                this.logger.log(`[자동 퇴장] 인간 참여자 없음`);
                this.stopBot(roomName);
            }
        });

        room.on(RoomEvent.Disconnected, (reason?: any) => {
            this.logger.warn(`[봇 연결 끊김] 사유: ${reason || 'UNKNOWN'}`);
            this.cleanupRoom(roomName);
        });

        try {
            await room.connect(livekitUrl, botToken);

            try {
                await this.ragClientService.connect(roomName);
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
                lastSttTime: 0,
                lastResponseTime: 0,
                speakingStartTime: 0,
                activeUserId: null,
                // 능동적 개입 초기화
                meetingContext: {
                    topic: null,
                    recentTranscripts: [],
                    discussedTopics: [],
                    lastProactiveTime: 0,
                    proactiveCount: 0,
                },
                lastSpeechTime: Date.now(),
                proactiveTimer: null,
            };
            this.activeRooms.set(roomName, context);

            this.startArmedTimeoutChecker(roomName);
            this.startProactiveChecker(roomName);  // 능동적 개입 체커 시작

            this.logger.log(`[봇 입장 성공] 참여자: ${room.remoteParticipants.size}명`);

            // 입장 인사 (캘리브레이션 동안 TTS로 시간 벌기)
            await this.greetOnJoin(roomName);

            // 기존 참여자의 오디오 트랙 처리
            for (const participant of room.remoteParticipants.values()) {
                if (!participant.identity.startsWith('ai-bot')) {
                    for (const publication of participant.trackPublications.values()) {
                        if (publication.track && publication.kind === TrackKind.KIND_AUDIO) {
                            await this.handleAudioTrack(roomName, publication.track as RemoteTrack, participant.identity);
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
    private async greetOnJoin(roomName: string): Promise<void> {
        const context = this.activeRooms.get(roomName);
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
                await this.publishAudio(roomName, context.audioSource, pcmBuffer);
            }
            
            context.botState = BotState.SLEEP;
            context.lastResponseTime = Date.now();
            this.logger.log(`[입장 인사 완료]`);
        } catch (error) {
            this.logger.warn(`[입장 인사 실패] ${error.message}`);
            context.botState = BotState.SLEEP;
        }
    }

    // =====================================================
    // 회의 맥락 관리
    // =====================================================

    /**
     * 대화 내용을 회의 맥락에 추가
     */
    private addToMeetingContext(
        context: RoomContext,
        userId: string,
        text: string,
        category?: string | null
    ): void {
        const entry: TranscriptEntry = {
            userId,
            text,
            timestamp: Date.now(),
            category,
        };

        context.meetingContext.recentTranscripts.push(entry);

        // 최대 개수 유지
        if (context.meetingContext.recentTranscripts.length > this.MAX_RECENT_TRANSCRIPTS) {
            context.meetingContext.recentTranscripts.shift();
        }

        // 논의된 주제 추출
        if (category && !context.meetingContext.discussedTopics.includes(category)) {
            context.meetingContext.discussedTopics.push(category);
        }

        // 회의 주제 추론 (첫 번째 의미있는 발화에서)
        if (!context.meetingContext.topic && text.length > 10) {
            this.inferMeetingTopic(context, text);
        }

        // 마지막 발화 시간 업데이트
        context.lastSpeechTime = Date.now();
    }

    /**
     * 회의 주제 추론
     */
    private inferMeetingTopic(context: RoomContext, text: string): void {
        // 회의 관련 키워드가 있으면 주제로 설정
        const topicPatterns = [
            /오늘\s*회의\s*(주제|안건).*?[은는이가]\s*(.+)/,
            /(.+?)\s*(관련|에\s*대해|논의|이야기)/,
            /(.+?)\s*(기획|프로젝트|계획)/,
        ];

        for (const pattern of topicPatterns) {
            const match = text.match(pattern);
            if (match) {
                const topic = match[2] || match[1];
                if (topic && topic.length >= 2 && topic.length <= 30) {
                    context.meetingContext.topic = topic.trim();
                    this.logger.log(`[회의 주제 추론] "${context.meetingContext.topic}"`);
                    return;
                }
            }
        }
    }

    // =====================================================
    // 능동적 개입 시스템
    // =====================================================

    /**
     * 능동적 개입 체커 시작
     */
    private startProactiveChecker(roomName: string): void {
        const checkInterval = setInterval(async () => {
            const context = this.activeRooms.get(roomName);
            if (!context) {
                clearInterval(checkInterval);
                return;
            }

            // 조건 체크
            if (!this.shouldTriggerProactive(context)) {
                return;
            }

            // 능동적 개입 실행
            await this.triggerProactiveIntervention(roomName, context);

        }, 5000);  // 5초마다 체크

        // 컨텍스트에 타이머 저장 (정리용)
        const context = this.activeRooms.get(roomName);
        if (context) {
            context.proactiveTimer = checkInterval;
        }
    }

    /**
     * 능동적 개입 조건 체크
     */
    private shouldTriggerProactive(context: RoomContext): boolean {
        const now = Date.now();

        // 1. 봇이 이미 말하고 있으면 안됨
        if (context.botState === BotState.SPEAKING || context.isPublishing) {
            return false;
        }

        // 2. 침묵 시간 체크
        const silenceDuration = now - context.lastSpeechTime;
        if (silenceDuration < this.PROACTIVE_SILENCE_THRESHOLD_MS) {
            return false;
        }

        // 3. 최소 대화 수 체크
        if (context.meetingContext.recentTranscripts.length < this.PROACTIVE_MIN_TRANSCRIPTS) {
            return false;
        }

        // 4. 최대 개입 횟수 체크
        if (context.meetingContext.proactiveCount >= this.PROACTIVE_MAX_PER_MEETING) {
            return false;
        }

        // 5. 쿨다운 체크
        if (now - context.meetingContext.lastProactiveTime < this.PROACTIVE_COOLDOWN_MS) {
            return false;
        }

        // 6. 인간 참여자가 2명 이상일 때만 (혼자면 필요없음)
        const humanCount = Array.from(context.room.remoteParticipants.values())
            .filter(p => !p.identity.startsWith('ai-bot')).length;
        if (humanCount < 2) {
            return false;
        }

        return true;
    }

    /**
     * 능동적 개입 실행
     */
    private async triggerProactiveIntervention(roomName: string, context: RoomContext): Promise<void> {
        // 락 획득 시도
        if (this.processingLock.get(roomName)) {
            this.logger.log(`[능동적 개입] 스킵 - 다른 처리 진행 중`);
            return;
        }

        // 이미 발화 중이면 스킵
        if (context.isPublishing || context.botState === BotState.SPEAKING) {
            this.logger.log(`[능동적 개입] 스킵 - 봇 발화 중`);
            return;
        }

        // 락 설정
        this.processingLock.set(roomName, true);
        this.logger.log(`\n========== [능동적 개입] ==========`);

        try {
            context.isPublishing = true;
            const requestId = Date.now();
            context.currentRequestId = requestId;

            // 1. 회의 맥락 기반 제안 생성
            const suggestion = await this.generateProactiveSuggestion(context);

            // 제안 생성 중 사용자가 말했으면 취소
            if (context.lastSpeechTime > Date.now() - 2000) {
                this.logger.log(`[능동적 개입] 취소 - 사용자 발화 감지`);
                return;
            }

            if (!suggestion) {
                this.logger.log(`[능동적 개입] 제안 생성 실패 - 스킵`);
                return;
            }

            this.logger.log(`[능동적 개입] "${suggestion.substring(0, 50)}..."`);

            // 2. 상태 업데이트
            context.meetingContext.lastProactiveTime = Date.now();
            context.meetingContext.proactiveCount++;

            // 3. DataChannel로 전송
            const proactiveMessage = {
                type: 'proactive_suggestion',
                text: suggestion,
                context: {
                    topic: context.meetingContext.topic,
                    discussedTopics: context.meetingContext.discussedTopics,
                },
            };

            const encoder = new TextEncoder();
            await context.room.localParticipant.publishData(
                encoder.encode(JSON.stringify(proactiveMessage)),
                { reliable: true }
            );

            // 4. TTS 발화
            context.botState = BotState.SPEAKING;
            context.speakingStartTime = Date.now();

            await this.speakAndPublish(context, roomName, requestId, suggestion);

            // 5. 완료 후 SLEEP으로 (ARMED 아님 - 직접 호출이 아니니까)
            context.botState = BotState.SLEEP;
            context.lastSpeechTime = Date.now();  // 봇 발화도 마지막 발화로 기록

            this.logger.log(`[능동적 개입 완료] 총 ${context.meetingContext.proactiveCount}회`);

        } catch (error) {
            this.logger.error(`[능동적 개입 에러] ${error.message}`);
        } finally {
            context.isPublishing = false;
            this.processingLock.set(roomName, false);  // 락 해제
        }
    }

    /**
     * 회의 맥락 기반 제안 생성
     */
    private async generateProactiveSuggestion(context: MeetingContext | RoomContext): Promise<string | null> {
        const meetingCtx = 'meetingContext' in context ? context.meetingContext : context;

        // 최근 대화 내용 정리
        const recentTexts = meetingCtx.recentTranscripts
            .slice(-10)
            .map(t => `[${t.userId}] ${t.text}`)
            .join('\n');

        if (!recentTexts || recentTexts.length < 20) {
            return null;
        }

        const prompt = this.buildProactivePrompt(meetingCtx, recentTexts);

        try {
            const response = await this.llmService.sendMessage(prompt, null);
            return response.text;
        } catch (error) {
            this.logger.error(`[제안 생성 실패] ${error.message}`);
            return null;
        }
    }

    /**
     * 능동적 개입 프롬프트 생성
     */
    private buildProactivePrompt(meetingCtx: MeetingContext, recentTexts: string): string {
        const topic = meetingCtx.topic || '(주제 미정)';
        const discussedTopics = meetingCtx.discussedTopics.length > 0
            ? meetingCtx.discussedTopics.join(', ')
            : '없음';

        return `당신은 회의에 참여 중인 동료 '아우라'예요. 로봇이 아니라 진짜 사람처럼 말해요.

## 상황
회의 중 20초 정도 조용해졌어요. 어색하지 않게 대화에 자연스럽게 끼어들어주세요.

## 회의 맥락
- 주제: ${topic}
- 얘기 나온 것들: ${discussedTopics}

## 최근 대화
${recentTexts}

## 말투 규칙 (매우 중요!)
1. **친한 동료처럼** - "~할까요?" ❌ → "~해볼까요?", "~하면 어때요?" ✅
2. **추임새 자연스럽게** - "아", "음", "아 맞다", "근데", "어" 등 사용
3. **짧고 캐주얼하게** - 1~2문장, 길어도 3문장
4. **강요 ❌** - 제안만 살짝, 거절해도 괜찮은 느낌으로
5. **이모티콘 사용 ❌** - 음성이라 이모티콘 없이

## 상황별 예시 (이런 느낌으로!)

### 대화가 끊겼을 때
- "음... 혹시 다른 얘기로 넘어갈까요?"
- "아 잠깐, 아까 그 얘기 더 하실 거 있으세요?"
- "어 근데 저 하나 궁금한 게 있는데요"

### 뭔가 정리가 필요해 보일 때  
- "아 제가 정리 좀 해볼게요, 맞는지 봐주세요"
- "잠깐만요, 제가 이해한 게 맞나 모르겠는데..."

### 도움을 제안할 때
- "아 그거 제가 잠깐 찾아볼까요?"
- "어 그거 제가 알아볼 수 있을 것 같은데요"

### 다음 주제로 넘어갈 때
- "그럼 다음 거 얘기해볼까요?"
- "아 그러면 이제 [주제] 얘기 해봐요"

## 절대 하지 말 것
- "도움이 필요하시면 말씀해주세요" (너무 로봇 같음)
- "무엇을 도와드릴까요?" (콜센터 같음)  
- "정리해드릴까요?" (비서 같음)
- 너무 길게 말하기
- 갑자기 뜬금없는 주제 꺼내기

## 응답 (짧게, 자연스럽게, 1개만)`;
    }

    // =====================================================
    // 아이디어 감지 및 브로드캐스트
    // =====================================================

    /**
     * 아이디어 의도 감지 및 DataChannel 전송
     */
    private async detectAndBroadcastIdea(
        roomName: string,
        context: RoomContext,
        transcript: string,
        userId: string
    ): Promise<void> {
        // 아이디어 트리거 패턴
        const IDEA_TRIGGER_PATTERNS = [
            /(.+?)[은는이가]\s*어때/,           // "~는 어때?"
            /(.+?)[하면으면]\s*어떨까/,         // "~하면 어떨까?"
            /(.+?)[도이가]\s*좋을\s*것\s*같/,   // "~도 좋을 것 같아"
            /(.+?)[하자해보자]/,                // "~하자"
            /(.+?)\s*추천/,                     // "~추천"
            /(.+?)\s*아이디어/,                 // "~아이디어"
            /(.+?)\s*제안/,                     // "~제안"
        ];

        let isIdeaIntent = false;
        let extractedIdea = '';

        // 패턴 매칭으로 아이디어 의도 감지
        for (const pattern of IDEA_TRIGGER_PATTERNS) {
            const match = transcript.match(pattern);
            if (match && match[1]) {
                isIdeaIntent = true;
                extractedIdea = match[1].trim();
                break;
            }
        }

        if (!isIdeaIntent || extractedIdea.length < 2) {
            return;  // 아이디어가 아니면 스킵
        }

        this.logger.log(`[아이디어 감지] "${extractedIdea}"`);

        try {
            // LLM으로 아이디어 정제
            const refinedIdea = await this.refineIdea(extractedIdea, transcript);

            if (!refinedIdea || refinedIdea.length < 3) {
                this.logger.log(`[아이디어] 정제 실패 - 스킵`);
                return;
            }

            this.logger.log(`[아이디어 정제] "${refinedIdea}"`);

            // DataChannel로 브로드캐스트
            const ideaMessage = {
                type: 'NEW_IDEA',
                idea: {
                    id: `idea-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
                    content: refinedIdea,
                    author: userId || '익명',
                },
            };

            const encoder = new TextEncoder();
            await context.room.localParticipant.publishData(
                encoder.encode(JSON.stringify(ideaMessage)),
                { reliable: true }
            );

            this.logger.log(`[아이디어 전송] "${refinedIdea}" by ${userId}`);
        } catch (error) {
            this.logger.error(`[아이디어 처리 에러] ${error.message}`);
        }
    }

    /**
     * LLM으로 아이디어 정제
     */
    private async refineIdea(extractedIdea: string, originalTranscript: string): Promise<string> {
        const prompt = `당신은 회의 중 나온 아이디어를 정제하는 전문가입니다.
다음 발화에서 핵심 아이디어만 짧고 명확하게 추출해주세요.

## 원본 발화
"${originalTranscript}"

## 추출된 키워드
"${extractedIdea}"

## 규칙
1. 포스트잇에 적을 수 있도록 짧게 (최대 30자)
2. 불필요한 조사, 말투 제거
3. 핵심 내용만 명사형으로
4. 이모티콘 없이 텍스트만

## 예시
입력: "SNS 마케팅 강화하면 어떨까요?"
출력: "SNS 마케팅 강화"

입력: "AI 기반 추천 시스템 도입은 어때?"
출력: "AI 기반 추천 시스템"

입력: "고객 피드백 자동 분석 툴 만들자"
출력: "고객 피드백 자동 분석 툴"

## 정제된 아이디어 (30자 이내):`;

        try {
            const response = await this.llmService.sendMessage(prompt, null);

            // 응답에서 따옴표 제거 및 정리
            let refined = response.text
                .replace(/["'""'']/g, '')
                .replace(/^정제된\s*아이디어[:\s]*/i, '')
                .replace(/^출력[:\s]*/i, '')
                .trim();

            // 너무 길면 자르기
            if (refined.length > 30) {
                refined = refined.substring(0, 30) + '...';
            }

            return refined;
        } catch (error) {
            this.logger.error(`[아이디어 정제 실패] ${error.message}`);
            // 실패 시 원본 반환
            return extractedIdea.substring(0, 30);
        }
    }

    // =====================================================
    // 오디오 처리
    // =====================================================

    private async handleAudioTrack(roomName: string, track: RemoteTrack, userId: string) {
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

        const SILENCE_THRESHOLD = 35;
        const MIN_AUDIO_LENGTH = 16000;
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

        const context = this.activeRooms.get(roomName);

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
                    context.lastSpeechTime = Date.now();  // 능동적 개입용 타이머 리셋
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
            if (silenceCount > SILENCE_THRESHOLD && totalLength > MIN_AUDIO_LENGTH) {
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
                    if (context && Date.now() - context.lastSttTime < STT_COOLDOWN_MS) {
                        continue;
                    }
                    if (context) {
                        context.lastSttTime = Date.now();
                    }

                    this.processAndRespond(roomName, fullAudio, userId).catch(err => {
                        this.logger.error(`[처리 에러] ${err.message}`);
                    });
                }
            }
        }
    }

    /**
     * 음성 처리 메인 로직
     * STT → Intent 분석 → (LLM 교정) → 검색/응답 → TTS
     */
    private async processAndRespond(roomName: string, audioBuffer: Buffer, userId: string) {
        const context = this.activeRooms.get(roomName);
        if (!context) return;

        // 락 획득 시도
        if (this.processingLock.get(roomName)) {
            this.logger.debug(`[스킵] 다른 처리 진행 중 (락)`);
            return;
        }

        if (context.isPublishing) {
            this.logger.debug(`[스킵] 이미 처리 중`);
            return;
        }

        const RESPONSE_COOLDOWN_MS = 3000;
        if (context.lastResponseTime > 0 && Date.now() - context.lastResponseTime < RESPONSE_COOLDOWN_MS) {
            this.logger.debug(`[스킵] 응답 쿨다운`);
            return;
        }

        // 락 설정
        this.processingLock.set(roomName, true);

        const requestId = Date.now();
        context.currentRequestId = requestId;
        const startTime = Date.now();

        this.logger.log(`\n========== [음성 처리] ${userId} ==========`);

        try {
            context.isPublishing = true;

            // ================================================
            // 1. STT (음성 → 텍스트) ~300ms
            // ================================================
            const sttStart = Date.now();
            const transcript = await this.sttService.transcribeFromBufferStream(audioBuffer, 'live-audio.pcm');
            this.logger.log(`[1.STT] ${Date.now() - sttStart}ms - "${transcript}"`);

            if (context.currentRequestId !== requestId) {
                return;  // finally에서 락 해제됨
            }
            if (!transcript.trim()) {
                this.logger.log(`[스킵] 빈 STT 결과`);
                return;  // finally에서 락 해제됨
            }

            // ★ 회의 맥락에 추가 (모든 발화 저장)
            const intentForContext = this.intentClassifier.classify(transcript);
            this.addToMeetingContext(context, userId, transcript, intentForContext.category);

            // ★ 아이디어 의도 감지 및 전송
            await this.detectAndBroadcastIdea(roomName, context, transcript, userId);

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
                return;  // finally에서 락 해제됨
            }

            // ================================================
            // 3. 스톱워드 처리
            // ================================================
            if (context.botState !== BotState.SLEEP && hasStopWord) {
                this.logger.log(`[스톱워드] → SLEEP`);
                context.botState = BotState.SPEAKING;
                await this.speakAndPublish(context, roomName, requestId, "알겠습니다. 다시 불러주세요.");
                context.botState = BotState.SLEEP;
                context.activeUserId = null;
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
                    await this.speakAndPublish(context, roomName, requestId, "네, 무엇을 도와드릴까요?");
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
                    roomName
                ).finally(() => { llmResolved = true; });

                // 700ms 후에도 응답 없으면 "생각중" 발화
                const thinkingTask = (async () => {
                    await this.sleep(700);
                    if (llmResolved || context.currentRequestId !== requestId) return;
                    this.logger.log(`[생각중] 응답 대기...`);
                    context.botState = BotState.SPEAKING;
                    thinkingSpoken = true;
                    await this.speakAndPublish(context, roomName, requestId, thinkingPhrase);
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
                await this.speakAndPublish(context, roomName, requestId, finalResponse);

                // 응답 완료 → SLEEP
                context.botState = BotState.SLEEP;
                context.activeUserId = null;
                context.lastResponseTime = Date.now();
                context.lastSpeechTime = Date.now();  // 봇 발화도 마지막 발화로 기록

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
            this.processingLock.set(roomName, false);  // 락 해제
        }
    }

    private async publishAudio(roomName: string, audioSource: AudioSource, pcmBuffer: Buffer): Promise<void> {
        const SAMPLE_RATE = 16000;
        const FRAME_SIZE = 480;
        const BYTES_PER_SAMPLE = 2;
        const FRAME_BYTES = FRAME_SIZE * BYTES_PER_SAMPLE;
        const BATCH_SIZE = 4;

        let offset = 0;
        let frameCount = 0;
        const startTime = Date.now();

        while (offset < pcmBuffer.length) {
            const context = this.activeRooms.get(roomName);
            if (context?.shouldInterrupt) {
                this.logger.log(`[오디오 중단] Barge-in`);
                context.shouldInterrupt = false;
                break;
            }

            for (let batch = 0; batch < BATCH_SIZE && offset < pcmBuffer.length; batch++) {
                const chunkEnd = Math.min(offset + FRAME_BYTES, pcmBuffer.length);
                const numSamples = Math.floor((chunkEnd - offset) / BYTES_PER_SAMPLE);

                const samples = new Int16Array(FRAME_SIZE);
                for (let i = 0; i < numSamples && i < FRAME_SIZE; i++) {
                    samples[i] = pcmBuffer.readInt16LE(offset + i * BYTES_PER_SAMPLE);
                }

                const frame = new AudioFrame(samples, SAMPLE_RATE, 1, FRAME_SIZE);
                await audioSource.captureFrame(frame);

                offset += FRAME_BYTES;
                frameCount++;
            }

            const expectedTime = frameCount * 30;
            const actualTime = Date.now() - startTime;
            const sleepTime = Math.max(0, expectedTime - actualTime - 10);

            if (sleepTime > 0) {
                await this.sleep(sleepTime);
            }
        }
    }

    private sleep(ms: number): Promise<void> {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    private async speakAndPublish(
        context: RoomContext,
        roomName: string,
        requestId: number,
        message: string
    ): Promise<void> {
        context.shouldInterrupt = false;

        const ttsStart = Date.now();
        const pcmAudio = await this.ttsService.synthesizePcm(message);
        this.logger.log(`[TTS] ${Date.now() - ttsStart}ms - ${pcmAudio.length} bytes`);

        context.speakingStartTime = Date.now();

        if (context.currentRequestId !== requestId) return;

        await this.publishAudio(roomName, context.audioSource, pcmAudio);
    }

    private startArmedTimeoutChecker(roomName: string): void {
        const checkInterval = setInterval(() => {
            const context = this.activeRooms.get(roomName);
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
     * 방 정리 (타이머 등)
     */
    private cleanupRoom(roomName: string): void {
        const context = this.activeRooms.get(roomName);
        if (context?.proactiveTimer) {
            clearInterval(context.proactiveTimer);
        }
        this.activeRooms.delete(roomName);
    }

    async stopBot(roomName: string): Promise<void> {
        const context = this.activeRooms.get(roomName);
        if (context) {
            try {
                await this.ragClientService.disconnect(roomName);
            } catch (error) {
                this.logger.error(`[RAG 해제 실패] ${error.message}`);
            }

            // 타이머 정리
            if (context.proactiveTimer) {
                clearInterval(context.proactiveTimer);
            }

            await context.room.disconnect();
            this.activeRooms.delete(roomName);
            this.logger.log(`[봇 종료] ${roomName}`);
        }
    }

    isActive(roomName: string): boolean {
        return this.activeRooms.has(roomName);
    }

    /**
     * 회의 맥락 조회 (디버깅/테스트용)
     */
    getMeetingContext(roomName: string): MeetingContext | null {
        const context = this.activeRooms.get(roomName);
        return context?.meetingContext || null;
    }
}