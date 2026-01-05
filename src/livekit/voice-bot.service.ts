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

        return `당신은 화상회의 AI 비서 '아우라'입니다.
회의 참여자들이 20초 이상 침묵하고 있습니다. 자연스럽게 대화를 이어가도록 도와주세요.

## 회의 정보
- 주제: ${topic}
- 지금까지 논의된 키워드: ${discussedTopics}

## 최근 대화 내용
${recentTexts}

## 응답 규칙
1. "혹시 제가 도움드릴 부분이 있을까요?" 또는 논의 내용 기반 제안
2. 대화 흐름에 맞는 자연스러운 질문이나 의견
3. 2-3문장 이내로 간결하게
4. 너무 튀지 않게, 부드럽게 개입
5. 강요하지 않고 선택지를 제시

## 응답 유형 (상황에 맞게 선택)
- 요약형: "지금까지 [주제]에 대해 논의하셨는데, 다음으로 넘어갈까요?"
- 질문형: "혹시 [관련 주제]에 대해서도 이야기해볼까요?"
- 제안형: "제가 [관련 정보]를 찾아드릴까요?"
- 확인형: "정리가 필요하시면 말씀해주세요!"

## 응답 (1개만, 자연스럽게)`;
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

            if (context.currentRequestId !== requestId) return;
            if (!transcript.trim()) return;

            // ★ 회의 맥락에 추가 (모든 발화 저장)
            const intentForContext = this.intentClassifier.classify(transcript);
            this.addToMeetingContext(context, userId, transcript, intentForContext.category);

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
                const thinkingPhrases = ["잠깐만요, 찾아볼게요.", "음, 확인해볼게요.", "잠시만요."];
                const thinkingPhrase = thinkingPhrases[Math.floor(Math.random() * thinkingPhrases.length)];
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

                const finalResponse = thinkingSpoken ? `네, ${llmResult.text.trim()}` : llmResult.text;

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