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
    SLEEP = 'SLEEP',       // 대기 상태 (웨이크워드 대기)
    ARMED = 'ARMED',       // 활성화 상태 (명령 수신 가능)
    SPEAKING = 'SPEAKING'  // 응답 중 상태
}

interface RoomContext {
    room: Room;
    audioSource: AudioSource;
    localAudioTrack: LocalAudioTrack;
    isPublishing: boolean;
    shouldInterrupt: boolean; // Barge-in: AI 발화 중단 플래그
    currentRequestId: number; // 최신 요청 ID (이전 요청 취소용)
    botState: BotState; // 상태머신 상태
    lastInteractionTime: number; // 마지막 상호작용 시간 (ARMED 타임아웃용)
    lastSttTime: number; // 마지막 STT 처리 시간 (쿨다운용)
    activeUserId: string | null; // 현재 대화 중인 사용자 ID
}

@Injectable()
export class VoiceBotService {
    private readonly logger = new Logger(VoiceBotService.name);
    private activeRooms: Map<string, RoomContext> = new Map();

    // 웨이크워드 및 스톱워드 설정
    private readonly WAKE_WORDS = [
        '헤이 빅스', '빅스야', '페이비스', '헤이픽스'
    ];
    private readonly STOP_WORDS = ['멈춰'];
    private readonly ARMED_TIMEOUT_MS = 30000; // 30초 후 SLEEP으로 복귀

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

        // 새 오디오 트랙 구독 시
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

            // 인간 참여자 수 확인 (ai-bot으로 시작하지 않는 참여자)
            const humanCount = Array.from(room.remoteParticipants.values())
                .filter(p => !p.identity.startsWith('ai-bot')).length;

            this.logger.log(`[남은 인간 참여자] ${humanCount}명`);

            // 인간 참여자가 없으면 봇 퇴장
            if (humanCount === 0) {
                this.logger.log(`[자동 퇴장] 인간 참여자가 없어 봇 퇴장`);
                this.stopBot(roomName);
            }
        });

        room.on(RoomEvent.Disconnected, (reason?: any) => {
            this.logger.warn(`[봇 연결 끊김] 사유: ${reason || 'UNKNOWN'}`);
            this.activeRooms.delete(roomName);
        });

        try {
            await room.connect(livekitUrl, botToken);

            // RAG WebSocket 연결
            try {
                await this.ragClientService.connect(roomName);
                this.logger.log(`[RAG 연결 완료] Room: ${roomName}`);
            } catch (error) {
                this.logger.error(`[RAG 연결 실패] ${error.message} - AI 봇은 응답하지 않습니다`);
                // RAG 없이도 봇은 입장하지만 응답하지 않음
            }

            // 오디오 소스 생성 (16kHz, 모노)
            const audioSource = new AudioSource(16000, 1);
            const localAudioTrack = LocalAudioTrack.createAudioTrack('ai-voice', audioSource);

            // 오디오 트랙 발행
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
                botState: BotState.SLEEP, // 초기 상태는 SLEEP
                lastInteractionTime: Date.now(),
                lastSttTime: 0,
                activeUserId: null, // 초기에는 활성 사용자 없음
            };
            this.activeRooms.set(roomName, context);

            // ARMED 타임아웃 체크 (30초마다)
            this.startArmedTimeoutChecker(roomName);

            this.logger.log(`[봇 입장 성공] 현재 참여자: ${room.remoteParticipants.size}명`);

            // 기존 참여자 오디오 트랙 구독
            for (const participant of room.remoteParticipants.values()) {
                if (!participant.identity.startsWith('ai-bot')) {
                    for (const publication of participant.trackPublications.values()) {
                        if (publication.track && publication.kind === TrackKind.KIND_AUDIO) {
                            this.logger.log(`[기존 오디오] ${participant.identity}`);
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
     * 오디오 트랙 처리 (VAD + 데시벨 기반 노이즈 필터링)
     * - RMS 기반 음량 측정
     * - 데시벨 임계값으로 배경 소음 차단
     * - 진폭 + 데시벨 모두 만족해야 발화로 인정
     */
    private async handleAudioTrack(roomName: string, track: RemoteTrack, userId: string) {
        this.logger.log(`[오디오 처리 시작] ${userId}`);

        // 16kHz 모노로 자동 변환
        const audioStream = new AudioStream(track, 16000, 1);

        // 자동 캘리브레이션: 처음 3초 동안 배경 소음 측정
        let isCalibrating = true;
        let calibrationSamples: number[] = [];
        const calibrationStartTime = Date.now();
        const CALIBRATION_DURATION = 3000; // 3초

        // 음성 데이터 수집 (VAD + 데시벨 기반 노이즈 필터링)
        let audioBuffer: Buffer[] = [];
        let silenceCount = 0;
        let voiceCount = 0; // 연속 발화 프레임 수

        const SILENCE_THRESHOLD = 35; // 35 프레임 (~1.1초 침묵 시 처리)
        const MIN_AUDIO_LENGTH = 16000; // 최소 오디오 길이 (~0.5초)
        const MIN_VOICE_FRAMES = 8; // 최소 8프레임 연속 발화 필요
        const BARGE_IN_DECIBEL_THRESHOLD = -28; // Barge-in용 높은 임계값
        const STRONG_VOICE_THRESHOLD = -24; // 매우 강한 발화 기준
        const STT_COOLDOWN_MS = 1200; // STT 처리 후 최소 쿨다운

        // 동적 임계값 (초기값, 캘리브레이션 후 자동 조정)
        let MIN_DECIBEL_THRESHOLD = -45;
        let VOICE_AMPLITUDE_THRESHOLD = 500;

        // 배경 소음 레벨 추적 (지수 이동 평균)
        let backgroundNoiseDB = -60; // 초기값
        const NOISE_UPDATE_ALPHA = 0.05; // 배경 소음 업데이트 속도
        const VOICE_MARGIN_DB = 10; // 배경 소음 + 10dB = 발화 임계값 (더 민감하게)

        // 발화자 음량 레벨 추적
        let speakerVoiceDB = -30; // 초기값 (발화자 평균 음량)
        let speakerSampleCount = 0;
        const SPEAKER_UPDATE_ALPHA = 0.15; // 발화자 음량 업데이트 속도 (더 빠르게)
        const MIN_SPEAKER_SAMPLES = 3; // 최소 발화 샘플 수 (3번만 말하면 조정)

        const context = this.activeRooms.get(roomName);

        for await (const frame of audioStream) {
            const frameBuffer = Buffer.from(frame.data.buffer);

            // VAD: RMS 기반 음량 + 데시벨 계산
            const samples = new Int16Array(frame.data.buffer);

            // RMS (Root Mean Square) 계산 - 더 정확한 음량 측정
            const rms = Math.sqrt(
                samples.reduce((sum, s) => sum + s * s, 0) / samples.length
            );

            // 데시벨 계산 (16-bit PCM 기준: -90dB ~ 0dB)
            const decibel = 20 * Math.log10(rms / 32768);

            // 평균 진폭 (기존 호환성)
            const avgAmplitude = samples.reduce((sum, s) => sum + Math.abs(s), 0) / samples.length;

            // 자동 캘리브레이션: 처음 3초 동안 배경 소음 샘플 수집
            if (isCalibrating) {
                const elapsed = Date.now() - calibrationStartTime;
                if (elapsed < CALIBRATION_DURATION) {
                    if (decibel > -90 && decibel < 0) { // 유효한 범위만
                        calibrationSamples.push(decibel);
                    }
                    continue; // 캘리브레이션 중에는 발화 감지 안 함
                } else {
                    // 캘리브레이션 완료: 배경 소음 레벨 계산
                    if (calibrationSamples.length > 0) {
                        backgroundNoiseDB = calibrationSamples.reduce((sum, db) => sum + db, 0) / calibrationSamples.length;
                        MIN_DECIBEL_THRESHOLD = backgroundNoiseDB + VOICE_MARGIN_DB;
                        // 진폭도 배경 소음에 맞춰 조정 (dB를 진폭으로 변환)
                        const noiseRMS = 32768 * Math.pow(10, backgroundNoiseDB / 20);
                        VOICE_AMPLITUDE_THRESHOLD = Math.max(300, Math.min(800, noiseRMS * 3));

                        this.logger.log(`[캘리브레이션 완료] 배경 소음: ${backgroundNoiseDB.toFixed(1)}dB, 발화 임계값: ${MIN_DECIBEL_THRESHOLD.toFixed(1)}dB, 진폭: ${VOICE_AMPLITUDE_THRESHOLD.toFixed(0)}`);
                    } else {
                        this.logger.warn(`[캘리브레이션 실패] 샘플 부족, 기본값 사용`);
                    }
                    isCalibrating = false;
                }
            }

            // 발화가 아닐 때 배경 소음 레벨 업데이트 (지수 이동 평균)
            if (!isCalibrating && decibel < MIN_DECIBEL_THRESHOLD - 5) {
                backgroundNoiseDB = backgroundNoiseDB * (1 - NOISE_UPDATE_ALPHA) + decibel * NOISE_UPDATE_ALPHA;
            }

            // 진짜 발화인지 체크: 진폭 + 데시벨 모두 만족해야 함
            const isVoice = avgAmplitude > VOICE_AMPLITUDE_THRESHOLD && decibel > MIN_DECIBEL_THRESHOLD;

            // 발화일 때 발화자 음량 레벨 업데이트
            if (!isCalibrating && isVoice) {
                speakerVoiceDB = speakerVoiceDB * (1 - SPEAKER_UPDATE_ALPHA) + decibel * SPEAKER_UPDATE_ALPHA;
                speakerSampleCount++;

                // 충분한 샘플이 모이면 임계값을 발화자와 배경 소음의 중간으로 조정
                if (speakerSampleCount >= MIN_SPEAKER_SAMPLES) {
                    // 배경 소음과 발화자 음량의 중간값 (30% 지점)
                    const optimalThreshold = backgroundNoiseDB + (speakerVoiceDB - backgroundNoiseDB) * 0.3;

                    // 임계값이 너무 많이 변하지 않도록 (2dB 이상 차이날 때만)
                    if (Math.abs(optimalThreshold - MIN_DECIBEL_THRESHOLD) > 2) {
                        MIN_DECIBEL_THRESHOLD = optimalThreshold;
                        // 진폭도 재조정
                        const thresholdRMS = 32768 * Math.pow(10, MIN_DECIBEL_THRESHOLD / 20);
                        VOICE_AMPLITUDE_THRESHOLD = Math.max(300, Math.min(800, thresholdRMS * 1.5));

                        this.logger.log(`[임계값 자동 조정] ${MIN_DECIBEL_THRESHOLD.toFixed(1)}dB (배경: ${backgroundNoiseDB.toFixed(1)}dB, 발화: ${speakerVoiceDB.toFixed(1)}dB, 진폭: ${VOICE_AMPLITUDE_THRESHOLD.toFixed(0)})`);
                    }
                }
            }

            // LLM/TTS 처리 중에는 신규 버퍼링 방지 (말 끊김/취소 방지)
            if (context?.isPublishing && context.botState !== BotState.SPEAKING) {
                continue;
            }

            // SPEAKING 중에는 끼어들기 판단만 수행
            if (context?.isPublishing && context.botState === BotState.SPEAKING) {
                if (isVoice && voiceCount >= MIN_VOICE_FRAMES && !context.shouldInterrupt &&
                    decibel > BARGE_IN_DECIBEL_THRESHOLD &&
                    (context.activeUserId === null || context.activeUserId === userId)) {
                    this.logger.log(`[Barge-in] ${userId} 끼어들기 감지 (dB: ${decibel.toFixed(1)})! AI 발화 중단`);
                    context.shouldInterrupt = true;
                }
                continue;
            }

            if (isVoice) {
                voiceCount++;
                if (context && voiceCount >= MIN_VOICE_FRAMES) {
                    context.lastInteractionTime = Date.now();
                }
                // 매우 강한 발화일 때만 침묵 카운트 리셋 (일반 발화 중에는 침묵 누적)
                if (decibel > STRONG_VOICE_THRESHOLD) {
                    silenceCount = 0;
                }
                audioBuffer.push(frameBuffer);

                // 디버깅: 첫 발화 프레임 로깅
                if (voiceCount === 1) {
                    this.logger.debug(`[VAD] 발화 감지 - RMS: ${rms.toFixed(0)}, dB: ${decibel.toFixed(1)}, 진폭: ${avgAmplitude.toFixed(0)}`);
                }

                // Barge-in: AI가 실제로 말하고 있을 때만 중단 가능
                // 더 높은 데시벨 임계값 적용 (봇 자기 목소리 차단)
                if (context && context.isPublishing && voiceCount >= MIN_VOICE_FRAMES &&
                    !context.shouldInterrupt && decibel > BARGE_IN_DECIBEL_THRESHOLD) {
                    // SPEAKING 상태(AI 발화 중)이고, 활성 사용자의 발화인 경우에만 중단
                    if (context.botState === BotState.SPEAKING &&
                        (context.activeUserId === null || context.activeUserId === userId)) {
                        this.logger.log(`[Barge-in] ${userId} 끼어들기 감지 (dB: ${decibel.toFixed(1)})! AI 발화 중단`);
                        context.shouldInterrupt = true;
                    }
                }
            } else if (avgAmplitude > 150 && decibel > -55) {
                // 약한 소리: 데시벨 기준도 추가 (너무 작은 소음 제외)
                audioBuffer.push(frameBuffer);
                silenceCount++;
            } else {
                // 침묵 또는 배경 소음 (임계값 미달)
                silenceCount++;
                voiceCount = 0;
            }

            // 충분한 침묵 + 최소 오디오 길이
            const totalLength = audioBuffer.reduce((sum, b) => sum + b.length, 0);
            if (silenceCount > SILENCE_THRESHOLD && totalLength > MIN_AUDIO_LENGTH) {
                const fullAudio = Buffer.concat(audioBuffer);

                // 전체 오디오 품질 체크 (배경 소음 필터링)
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

                // 전체 오디오가 최소 데시벨을 만족하는 경우만 처리
                if (fullDecibel > MIN_DECIBEL_THRESHOLD - 5) { // 약간의 여유 (-50dB)
                    if (context && Date.now() - context.lastSttTime < STT_COOLDOWN_MS) {
                        this.logger.debug('[쿨다운] STT 대기 중 - 이번 발화는 스킵');
                        continue;
                    }
                    if (context) {
                        context.lastSttTime = Date.now();
                    }
                    this.logger.debug(`[오디오 품질] RMS: ${fullRms.toFixed(0)}, dB: ${fullDecibel.toFixed(1)} - 처리 진행`);

                    // 비동기로 처리 (블로킹 방지)
                    this.processAndRespond(roomName, fullAudio, userId).catch(err => {
                        this.logger.error(`[처리 에러] ${err.message}`);
                    });
                } else {
                    this.logger.debug(`[오디오 품질] dB: ${fullDecibel.toFixed(1)} - 배경 소음으로 판단, 무시`);
                }
            }
        }
    }

    private async processAndRespond(roomName: string, audioBuffer: Buffer, userId: string) {
        const context = this.activeRooms.get(roomName);
        if (!context) {
            this.logger.warn(`[스킵] 방 컨텍스트 없음: ${roomName}`);
            return;
        }

        // 처리 중이면 새 요청을 막아 말 끊김/취소 방지
        if (context.isPublishing) {
            this.logger.warn(`[스킵] 처리 중 (${context.botState}) - 새 요청 무시`);
            return;
        }

        // 새 요청 ID 생성 (이전 요청 무효화)
        const requestId = Date.now();
        context.currentRequestId = requestId;

        const startTime = Date.now();
        this.logger.log(`\n========== [음성 처리 시작] ${userId} ==========`);
        this.logger.log(`오디오 크기: ${audioBuffer.length} bytes`);
        this.logger.log(`현재 상태: ${context.botState}`);

        try {
            context.isPublishing = true;

            // 1. STT (음성 → 텍스트)
            const sttStart = Date.now();
            const transcript = await this.sttService.transcribeFromBufferStream(audioBuffer, 'live-audio.pcm');
            const sttLatency = Date.now() - sttStart;
            this.logger.log(`[1. STT 완료] ${sttLatency}ms - \"${transcript}\"`);

            // 최신 요청 체크
            if (context.currentRequestId !== requestId) {
                this.logger.log(`[취소됨] 더 최신 요청이 있음 (STT 후)`);
                return;
            }

            if (!transcript.trim()) {
                this.logger.log(`[스킵] 빈 텍스트`);
                return;
            }

            // === 상태머신 처리 ===
            // 의도 분석 (IntentClassifier 사용)
            const intentAnalysis = this.intentClassifier.classify(transcript);
            const normalizedTranscript = intentAnalysis.normalizedText;
            let processText = intentAnalysis.normalizedText; // 처리할 텍스트 (웨이크워드 제거될 수 있음)
            this.logger.debug(`[Intent] "${transcript}" → Call:${intentAnalysis.isCallIntent}, Question:${intentAnalysis.isQuestionIntent}, BotRelated:${intentAnalysis.isBotRelated}, Confidence:${intentAnalysis.confidence.toFixed(2)}`);

            // 너무 짧은 텍스트(추임새)는 무시 - 완화 (2글자 이하만 필터링)
            // 웨이크워드/스톱워드면 짧아도 처리
            const isShort = transcript.trim().length <= 2;
            const hasStopWordQuick = this.STOP_WORDS.some(word =>
                normalizedTranscript.includes(word.toLowerCase())
            );
            if (isShort && !intentAnalysis.isCallIntent && !hasStopWordQuick) {
                this.logger.log(`[스킵] 짧은 추임새: "${transcript}"`);
                return;
            }

            // 1. 웨이크워드 체크 (모든 상태에서 우선 처리)
            const hasWakeWord = intentAnalysis.isCallIntent;

            if (hasWakeWord) {
                this.logger.log(`[웨이크워드 감지] ${userId}: "${transcript}" → ARMED 상태로 전환 (패턴: ${intentAnalysis.matchedPatterns.join(', ')})`);
                context.lastInteractionTime = Date.now();
                context.activeUserId = userId; // 발화자 추적 시작
                context.shouldInterrupt = true; // 기존 발화 중단
                context.botState = BotState.ARMED;

                // 웨이크워드 제거하고 나머지 텍스트 추출
                for (const word of this.WAKE_WORDS) {
                    processText = processText.replace(new RegExp(word, 'gi'), '').trim();
                }
                processText = processText.replace(/^(야|아)\s*/i, '').trim();

                // 웨이크워드 제거 후 의미 있는 텍스트가 있으면 바로 처리
                if (processText.length > 3) {
                    if (!intentAnalysis.isQuestionIntent &&
                        !intentAnalysis.hasCommandWord &&
                        !intentAnalysis.hasRequestPattern &&
                        !intentAnalysis.hasQuestionPattern) {
                        this.logger.log(`[웨이크워드 + 일반 발화] 질문 아님 → 안내 응답`);
                        context.shouldInterrupt = false;
                        context.botState = BotState.SPEAKING;
                        await this.speakAndPublish(context, roomName, requestId, "네, 무엇을 도와드릴까요?");
                        context.botState = BotState.ARMED;
                        context.lastInteractionTime = Date.now();
                        return;
                    }

                    this.logger.log(`[웨이크워드 + 질문] 바로 처리: "${processText}"`);
                    // 질문을 바로 처리하도록 계속 진행 (아래 ARMED 상태 처리로)
                } else {
                    // 웨이크워드만 있으면 응답하고 종료
                    this.logger.log(`[웨이크워드만 감지] 대기 모드 활성화`);
                    context.shouldInterrupt = false; // Barge-in 플래그 리셋
                    context.botState = BotState.SPEAKING;
                    await this.speakAndPublish(context, roomName, requestId, "네, 무엇을 도와드릴까요?");
                    context.botState = BotState.ARMED;
                    context.lastInteractionTime = Date.now();
                    return;
                }
            }

            // 2. 스톱워드 체크 (ARMED/SPEAKING 상태에서만)
            if (context.botState !== BotState.SLEEP) {
                if (hasStopWordQuick) {
                    this.logger.log(`[스톱워드 감지] ${userId}: "${transcript}" → SLEEP 상태로 전환`);
                    context.shouldInterrupt = true; // 진행 중인 발화 중단

                    // 스톱 응답 중에는 SPEAKING 상태 (자기 목소리로 인한 Barge-in 방지)
                    context.shouldInterrupt = false; // 새 응답 시작 전 Barge-in 플래그 리셋
                    context.botState = BotState.SPEAKING;
                    await this.speakAndPublish(context, roomName, requestId, "알겠습니다. 다시 불러주세요.");

                    // 응답 완료 후 SLEEP으로 전환
                    context.botState = BotState.SLEEP;
                    context.activeUserId = null; // 활성 사용자 초기화
                    return;
                }
            }

            // 3. SLEEP 상태: 웨이크워드 없으면 무시
            if (context.botState === BotState.SLEEP) {
                this.logger.log(`[SLEEP 상태] 웨이크워드 없음 - 무시`);
                return;
            }

            // 4. SPEAKING 상태: 응답 중이면 무시 (웨이크워드/스톱워드는 위에서 이미 처리됨)
            if (context.botState === BotState.SPEAKING) {
                this.logger.log(`[SPEAKING 상태] 응답 중 - 무시`);
                return;
            }

            // 5. ARMED 상태: 일반 명령 처리
            if (context.botState === BotState.ARMED) {
                // 활성 사용자만 명령 가능
                if (context.activeUserId && context.activeUserId !== userId) {
                    this.logger.log(`[스킵] ${userId}는 활성 사용자(${context.activeUserId})가 아님`);
                    return;
                }

                // 웨이크워드/봇 호칭이 없으면 무시 (불필요한 끼어들기 방지)
                if (!hasWakeWord && !intentAnalysis.isBotRelated) {
                    this.logger.log(`[스킵] 웨이크워드/호칭 없음 - 무시`);
                    return;
                }

                // Intent 기반 필터링: 봇에게 말하는 것이 아니면 무시
                if (!intentAnalysis.isQuestionIntent &&
                    !intentAnalysis.hasCommandWord &&
                    !intentAnalysis.hasRequestPattern &&
                    !intentAnalysis.hasQuestionPattern) {
                    this.logger.log(`[스킵] 웨이크워드 이후 질문 아님`);
                    return;
                }

                context.lastInteractionTime = Date.now();

                // 2. LLM (ARMED 상태 유지 - 사용자 재발화 가능)
                // processText 사용 (웨이크워드가 제거된 텍스트)
                const llmStart = Date.now();
                const thinkingPhrases = [
                    "잠깐만요, 생각해볼게요.",
                    "음… 정리해볼게요.",
                    "잠시만요, 확인하고 말씀드릴게요."
                ];
                const thinkingPhrase = thinkingPhrases[Math.floor(Math.random() * thinkingPhrases.length)];
                let thinkingSpoken = false;
                let llmResolved = false;
                const llmPromise = this.llmService.sendMessage(processText, intentAnalysis.searchDomain).finally(() => {
                    llmResolved = true;
                });
                const thinkingTask = (async () => {
                    await this.sleep(700);
                    if (llmResolved || context.currentRequestId !== requestId) {
                        return;
                    }
                    this.logger.log(`[생각중] 응답 준비 중...`);
                    context.shouldInterrupt = false;
                    context.botState = BotState.SPEAKING;
                    thinkingSpoken = true;
                    await this.speakAndPublish(context, roomName, requestId, thinkingPhrase);
                    context.botState = BotState.ARMED;
                    context.lastInteractionTime = Date.now();
                })();
                const llmResult = await llmPromise;
                await thinkingTask;
                const finalResponse = thinkingSpoken ? `네, ${llmResult.text.trim()}` : llmResult.text;
                const llmLatency = Date.now() - llmStart;
                this.logger.log(`[LLM] ${llmLatency}ms - "${llmResult.text.substring(0, 50)}..."`);

                // 최신 요청 체크
                if (context.currentRequestId !== requestId) {
                    this.logger.log(`[취소됨] 더 최신 요청이 있음 (LLM 후)`);
                    return;
                }

                // 검색 결과가 있으면 DataChannel로 전송
                this.logger.log(`[검색 결과 확인] searchResults exists: ${!!llmResult.searchResults}, length: ${llmResult.searchResults?.length || 0}`);
                if (llmResult.searchResults && llmResult.searchResults.length > 0) {
                    this.logger.log(`[검색 결과 전송 시작] ${llmResult.searchResults.length}개 결과`);
                    const primaryResult = llmResult.searchResults[0];
                    const routeInfo = await this.llmService.getRouteInfo(primaryResult);
                    const searchMessage = {
                        type: 'search_answer',
                        text: finalResponse,
                        results: llmResult.searchResults,
                        route: routeInfo || undefined,
                    };
                    this.logger.log(`[검색 결과 메시지] ${JSON.stringify(searchMessage).substring(0, 200)}`);
                    const encoder = new TextEncoder();
                    const data = encoder.encode(JSON.stringify(searchMessage));
                    this.logger.log(`[DataChannel 전송] 데이터 크기: ${data.length} bytes`);
                    await context.room.localParticipant.publishData(data, { reliable: true });
                    this.logger.log(`[DataChannel 전송 완료]`);
                } else {
                    this.logger.log(`[검색 결과 없음] 일반 응답만 전송`);
                }

                // 3. TTS + 발행 (이제 SPEAKING 상태로 전환)
                context.shouldInterrupt = false; // Barge-in 플래그 리셋 (새로운 응답 시작)
                context.botState = BotState.SPEAKING;
                await this.speakAndPublish(context, roomName, requestId, finalResponse);

                // 응답 완료 후 SLEEP으로 복귀
                context.botState = BotState.SLEEP;
                context.activeUserId = null;
                context.lastInteractionTime = Date.now();

                const totalLatency = Date.now() - startTime;
                this.logger.log(`========== [완료] 총 ${totalLatency}ms ==========\n`);
            }

        } catch (error) {
            this.logger.error(`[처리 실패] ${error.message}`, error.stack);
            // 에러 발생 시에도 상태 리셋
            context.botState = BotState.ARMED;
        } finally {
            // 현재 요청인 경우만 상태 리셋 (경쟁 조건 방지)
            if (context.currentRequestId === requestId) {
                context.isPublishing = false;
                this.logger.log(`[상태 리셋] isPublishing = false (requestId: ${requestId})`);
            } else {
                this.logger.warn(`[상태 리셋 스킵] 다른 요청 진행 중 (current: ${context.currentRequestId}, this: ${requestId})`);
            }
        }
    }

    private async publishAudio(roomName: string, audioSource: AudioSource, pcmBuffer: Buffer): Promise<void> {
        const SAMPLE_RATE = 16000;
        const FRAME_SIZE = 480; // 30ms 프레임 (16000 / 1000 * 30)
        const BYTES_PER_SAMPLE = 2; // 16-bit = 2 bytes
        const FRAME_BYTES = FRAME_SIZE * BYTES_PER_SAMPLE;

        this.logger.log(`[오디오 발행] 총 ${pcmBuffer.length} bytes, ${Math.ceil(pcmBuffer.length / FRAME_BYTES)} 프레임`);

        let offset = 0;
        while (offset < pcmBuffer.length) {
            // Barge-in 체크: 사용자가 끼어들면 즉시 중단
            const context = this.activeRooms.get(roomName);
            if (context?.shouldInterrupt) {
                this.logger.log(`[오디오 발행 중단] Barge-in으로 인해 ${Math.ceil((pcmBuffer.length - offset) / FRAME_BYTES)} 프레임 건너뜀`);
                context.shouldInterrupt = false; // 플래그 리셋
                break;
            }

            const chunkEnd = Math.min(offset + FRAME_BYTES, pcmBuffer.length);
            const chunkLength = chunkEnd - offset;
            const numSamples = Math.floor(chunkLength / BYTES_PER_SAMPLE);

            // Buffer에서 Int16 Little Endian으로 직접 읽기
            const samples = new Int16Array(FRAME_SIZE);
            for (let i = 0; i < numSamples && i < FRAME_SIZE; i++) {
                samples[i] = pcmBuffer.readInt16LE(offset + i * BYTES_PER_SAMPLE);
            }

            const frame = new AudioFrame(samples, SAMPLE_RATE, 1, FRAME_SIZE);
            await audioSource.captureFrame(frame);

            offset += FRAME_BYTES;

            // 실시간 재생 속도에 맞추기 (30ms per frame)
            await this.sleep(25); // 약간의 버퍼 확보를 위해 25ms
        }

        this.logger.log(`[오디오 발행 완료]`);
    }

    private sleep(ms: number): Promise<void> {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    /**
     * TTS + 오디오 발행 헬퍼
     */
    private async speakAndPublish(
        context: RoomContext,
        roomName: string,
        requestId: number,
        message: string
    ): Promise<void> {
        // 직전 끼어들기 플래그가 있으면 초기화해 발화가 즉시 끊기지 않게 함
        context.shouldInterrupt = false;
        const ttsStart = Date.now();
        const pcmAudio = await this.ttsService.synthesizePcm(message);
        const ttsLatency = Date.now() - ttsStart;
        this.logger.log(`[TTS] ${ttsLatency}ms - ${pcmAudio.length} bytes`);

        // 최신 요청 체크
        if (context.currentRequestId !== requestId) {
            this.logger.log(`[취소됨] 더 최신 요청이 있음 (TTS 후)`);
            return;
        }

        // LiveKit으로 오디오 발행
        await this.publishAudio(roomName, context.audioSource, pcmAudio);
    }

    /**
     * ARMED 타임아웃 체크 (30초 동안 상호작용 없으면 SLEEP으로 복귀)
     */
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
                    this.logger.log(`[타임아웃] ${this.ARMED_TIMEOUT_MS / 1000}초 동안 상호작용 없음 → SLEEP 상태로 복귀`);
                    context.botState = BotState.SLEEP;
                    context.activeUserId = null; // 활성 사용자 초기화
                }
            }
        }, 5000); // 5초마다 체크
    }

    async stopBot(roomName: string): Promise<void> {
        const context = this.activeRooms.get(roomName);
        if (context) {
            // RAG WebSocket 연결 해제
            try {
                await this.ragClientService.disconnect(roomName);
                this.logger.log(`[RAG 연결 해제 완료]`);
            } catch (error) {
                this.logger.error(`[RAG 연결 해제 실패] ${error.message}`);
            }

            await context.room.disconnect();
            this.activeRooms.delete(roomName);
            this.logger.log(`[봇 종료] ${roomName}`);
        }
    }

    isActive(roomName: string): boolean {
        return this.activeRooms.has(roomName);
    }
}
