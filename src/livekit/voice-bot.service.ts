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
import { IntentClassifierService, IntentAnalysis } from '../intent/intent-classifier.service';

enum BotState {
    SLEEP = 'SLEEP',
    ARMED = 'ARMED',
    SPEAKING = 'SPEAKING'
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
}

@Injectable()
export class VoiceBotService {
    private readonly logger = new Logger(VoiceBotService.name);
    private activeRooms: Map<string, RoomContext> = new Map();

    private readonly STOP_WORDS = ['멈춰', '그만', '스톱', '중지'];
    private readonly ARMED_TIMEOUT_MS = 30000;

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

            this.logger.log(`[남은 인간 참여자] ${humanCount}명`);

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

            try {
                await this.ragClientService.connect(roomName);
                this.logger.log(`[RAG 연결 완료] Room: ${roomName}`);
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
            };
            this.activeRooms.set(roomName, context);

            this.startArmedTimeoutChecker(roomName);

            this.logger.log(`[봇 입장 성공] 현재 참여자: ${room.remoteParticipants.size}명`);

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

    private async handleAudioTrack(roomName: string, track: RemoteTrack, userId: string) {
        this.logger.log(`[오디오 처리 시작] ${userId}`);

        const audioStream = new AudioStream(track, 16000, 1);

        let isCalibrating = true;
        let calibrationSamples: number[] = [];
        const calibrationStartTime = Date.now();
        const CALIBRATION_DURATION = 3000;

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

                        this.logger.log(`[캘리브레이션 완료] 배경 소음: ${backgroundNoiseDB.toFixed(1)}dB, 발화 임계값: ${MIN_DECIBEL_THRESHOLD.toFixed(1)}dB`);
                    } else {
                        this.logger.warn(`[캘리브레이션 실패] 샘플 부족, 기본값 사용`);
                    }
                    isCalibrating = false;
                }
            }

            if (!isCalibrating && decibel < MIN_DECIBEL_THRESHOLD - 5) {
                backgroundNoiseDB = backgroundNoiseDB * (1 - NOISE_UPDATE_ALPHA) + decibel * NOISE_UPDATE_ALPHA;
            }

            const isVoice = avgAmplitude > VOICE_AMPLITUDE_THRESHOLD && decibel > MIN_DECIBEL_THRESHOLD;

            if (!isCalibrating && isVoice) {
                speakerVoiceDB = speakerVoiceDB * (1 - SPEAKER_UPDATE_ALPHA) + decibel * SPEAKER_UPDATE_ALPHA;
                speakerSampleCount++;

                if (speakerSampleCount >= MIN_SPEAKER_SAMPLES) {
                    const optimalThreshold = backgroundNoiseDB + (speakerVoiceDB - backgroundNoiseDB) * 0.3;

                    if (Math.abs(optimalThreshold - MIN_DECIBEL_THRESHOLD) > 2) {
                        MIN_DECIBEL_THRESHOLD = optimalThreshold;
                        const thresholdRMS = 32768 * Math.pow(10, MIN_DECIBEL_THRESHOLD / 20);
                        VOICE_AMPLITUDE_THRESHOLD = Math.max(300, Math.min(800, thresholdRMS * 1.5));

                        this.logger.log(`[임계값 자동 조정] ${MIN_DECIBEL_THRESHOLD.toFixed(1)}dB`);
                    }
                }
            }

            if (context?.isPublishing && context.botState !== BotState.SPEAKING) {
                continue;
            }

            if (context?.isPublishing && context.botState === BotState.SPEAKING) {
                const BARGE_IN_GRACE_PERIOD_MS = 500;
                const timeSinceSpeakingStart = Date.now() - context.speakingStartTime;

                if (timeSinceSpeakingStart < BARGE_IN_GRACE_PERIOD_MS) {
                    continue;
                }

                if (isVoice && voiceCount >= MIN_VOICE_FRAMES && !context.shouldInterrupt &&
                    decibel > BARGE_IN_DECIBEL_THRESHOLD &&
                    (context.activeUserId === null || context.activeUserId === userId)) {
                    this.logger.log(`[Barge-in] ${userId} 끼어들기 감지! AI 발화 중단`);
                    context.shouldInterrupt = true;
                }
                continue;
            }

            if (isVoice) {
                voiceCount++;
                if (context && voiceCount >= MIN_VOICE_FRAMES) {
                    context.lastInteractionTime = Date.now();
                }
                if (decibel > STRONG_VOICE_THRESHOLD) {
                    silenceCount = 0;
                }
                audioBuffer.push(frameBuffer);

                if (voiceCount === 1) {
                    this.logger.debug(`[VAD] 발화 감지 - dB: ${decibel.toFixed(1)}, 진폭: ${avgAmplitude.toFixed(0)}`);
                }

                const BARGE_IN_GRACE_MS = 500;
                const speakingElapsed = context ? Date.now() - context.speakingStartTime : Infinity;
                if (context && context.isPublishing && voiceCount >= MIN_VOICE_FRAMES &&
                    !context.shouldInterrupt && decibel > BARGE_IN_DECIBEL_THRESHOLD &&
                    speakingElapsed >= BARGE_IN_GRACE_MS) {
                    if (context.botState === BotState.SPEAKING &&
                        (context.activeUserId === null || context.activeUserId === userId)) {
                        this.logger.log(`[Barge-in] ${userId} 끼어들기 감지! AI 발화 중단`);
                        context.shouldInterrupt = true;
                    }
                }
            } else if (avgAmplitude > 150 && decibel > -55) {
                audioBuffer.push(frameBuffer);
                silenceCount++;
            } else {
                silenceCount++;
                voiceCount = 0;
            }

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
                        this.logger.debug('[쿨다운] STT 대기 중 - 스킵');
                        continue;
                    }
                    if (context) {
                        context.lastSttTime = Date.now();
                    }
                    this.logger.debug(`[오디오 품질] dB: ${fullDecibel.toFixed(1)} - 처리 진행`);

                    this.processAndRespond(roomName, fullAudio, userId).catch(err => {
                        this.logger.error(`[처리 에러] ${err.message}`);
                    });
                } else {
                    this.logger.debug(`[오디오 품질] dB: ${fullDecibel.toFixed(1)} - 배경 소음, 무시`);
                }
            }
        }
    }

    /**
     * 음성 처리 메인 로직 (STT → Intent → LLM 교정 → 검색 → 응답)
     */
    private async processAndRespond(roomName: string, audioBuffer: Buffer, userId: string) {
        const context = this.activeRooms.get(roomName);
        if (!context) {
            this.logger.warn(`[스킵] 방 컨텍스트 없음: ${roomName}`);
            return;
        }

        if (context.isPublishing) {
            this.logger.warn(`[스킵] 처리 중 (${context.botState})`);
            return;
        }

        const RESPONSE_COOLDOWN_MS = 3000;
        const timeSinceLastResponse = Date.now() - context.lastResponseTime;
        if (context.lastResponseTime > 0 && timeSinceLastResponse < RESPONSE_COOLDOWN_MS) {
            this.logger.warn(`[스킵] 응답 쿨다운 중`);
            return;
        }

        const requestId = Date.now();
        context.currentRequestId = requestId;

        const startTime = Date.now();
        this.logger.log(`\n========== [음성 처리 시작] ${userId} ==========`);
        this.logger.log(`오디오 크기: ${audioBuffer.length} bytes, 상태: ${context.botState}`);

        try {
            context.isPublishing = true;

            // ========================================
            // 1. STT (음성 → 텍스트) ~300ms
            // ========================================
            const sttStart = Date.now();
            const transcript = await this.sttService.transcribeFromBufferStream(audioBuffer, 'live-audio.pcm');
            const sttLatency = Date.now() - sttStart;
            this.logger.log(`[1. STT] ${sttLatency}ms - "${transcript}"`);

            if (context.currentRequestId !== requestId) {
                this.logger.log(`[취소됨] 더 최신 요청이 있음 (STT 후)`);
                return;
            }

            if (!transcript.trim()) {
                this.logger.log(`[스킵] 빈 텍스트`);
                return;
            }

            // ========================================
            // 2. 빠른 의도 분석 (패턴 + 퍼지 매칭) ~5ms
            // ========================================
            const intentStart = Date.now();
            const intentAnalysis = this.intentClassifier.classify(transcript);
            const intentLatency = Date.now() - intentStart;
            
            this.logger.log(`[2. Intent] ${intentLatency}ms - call=${intentAnalysis.isCallIntent}, conf=${intentAnalysis.confidence.toFixed(2)}, cat=${intentAnalysis.category || 'none'}, needsLlm=${intentAnalysis.needsLlmCorrection}`);
            this.logger.log(`   patterns: ${intentAnalysis.matchedPatterns.join(', ') || 'none'}`);

            // 너무 짧은 텍스트 필터링 (웨이크워드/스톱워드 제외)
            const isShort = transcript.trim().length <= 2;
            const hasStopWord = this.STOP_WORDS.some(word =>
                intentAnalysis.normalizedText.toLowerCase().includes(word.toLowerCase())
            );
            
            if (isShort && !intentAnalysis.isCallIntent && !hasStopWord) {
                this.logger.log(`[스킵] 짧은 추임새: "${transcript}"`);
                return;
            }

            // ========================================
            // 3. 스톱워드 처리
            // ========================================
            if (context.botState !== BotState.SLEEP && hasStopWord) {
                this.logger.log(`[스톱워드 감지] "${transcript}" → SLEEP 전환`);
                context.shouldInterrupt = true;
                context.shouldInterrupt = false;
                context.botState = BotState.SPEAKING;
                await this.speakAndPublish(context, roomName, requestId, "알겠습니다. 다시 불러주세요.");
                context.botState = BotState.SLEEP;
                context.activeUserId = null;
                context.lastResponseTime = Date.now();
                return;
            }

            // ========================================
            // 4. 웨이크워드 감지 + LLM 교정 (필요시)
            // ========================================
            let shouldRespond = intentAnalysis.isCallIntent;
            let processedText = intentAnalysis.normalizedText;
            let searchKeyword = intentAnalysis.extractedKeyword;
            let searchType = intentAnalysis.searchType;
            let category = intentAnalysis.category;

            // 웨이크워드가 확실하면 (confidence >= 0.6) 바로 처리
            // 불확실하지만 가능성 있으면 (needsLlmCorrection) LLM 교정
            if (!shouldRespond && intentAnalysis.needsLlmCorrection) {
                this.logger.log(`[3. LLM 교정 시작] confidence=${intentAnalysis.confidence.toFixed(2)}`);
                
                const llmCorrectionStart = Date.now();
                const correctionResult = await this.sttService.correctWithLlm(transcript);
                const llmCorrectionLatency = Date.now() - llmCorrectionStart;
                
                this.logger.log(`[3. LLM 교정] ${llmCorrectionLatency}ms - wake=${correctionResult.hasWakeWord}, cat=${correctionResult.category}, kw="${correctionResult.searchKeyword}"`);

                if (correctionResult.hasWakeWord) {
                    shouldRespond = true;
                    processedText = correctionResult.correctedText;
                    searchKeyword = correctionResult.searchKeyword;
                    searchType = correctionResult.searchType;
                    category = correctionResult.category;
                }
            }

            // ========================================
            // 5. SLEEP 상태: 웨이크워드 없으면 무시
            // ========================================
            if (context.botState === BotState.SLEEP) {
                if (!shouldRespond) {
                    this.logger.log(`[SLEEP] 웨이크워드 없음 - 무시`);
                    return;
                }

                // 웨이크워드 감지 → ARMED 전환
                this.logger.log(`[웨이크워드 감지] "${transcript}" → ARMED 전환`);
                context.lastInteractionTime = Date.now();
                context.activeUserId = userId;
                context.botState = BotState.ARMED;

                // 웨이크워드만 있고 질문이 없으면 안내 응답
                const hasQuestion = intentAnalysis.isQuestionIntent ||
                    intentAnalysis.hasCommandWord ||
                    intentAnalysis.hasRequestPattern;

                if (!hasQuestion || !searchKeyword || searchKeyword.length < 2) {
                    this.logger.log(`[웨이크워드만] 안내 응답`);
                    context.botState = BotState.SPEAKING;
                    await this.speakAndPublish(context, roomName, requestId, "네, 무엇을 도와드릴까요?");
                    context.botState = BotState.ARMED;
                    context.lastInteractionTime = Date.now();
                    context.lastResponseTime = Date.now();
                    return;
                }
            }

            // ========================================
            // 6. SPEAKING 상태: 무시 (웨이크워드/스톱워드는 위에서 처리됨)
            // ========================================
            if (context.botState === BotState.SPEAKING) {
                this.logger.log(`[SPEAKING] 응답 중 - 무시`);
                return;
            }

            // ========================================
            // 7. ARMED 상태: 명령 처리
            // ========================================
            if (context.botState === BotState.ARMED) {
                // 활성 사용자만 명령 가능
                if (context.activeUserId && context.activeUserId !== userId) {
                    this.logger.log(`[스킵] ${userId}는 활성 사용자(${context.activeUserId})가 아님`);
                    return;
                }

                // 웨이크워드/봇 호칭 없으면 무시
                if (!shouldRespond && !intentAnalysis.isBotRelated) {
                    this.logger.log(`[스킵] 웨이크워드/호칭 없음`);
                    return;
                }

                // 질문이 아니면 무시
                if (!intentAnalysis.isQuestionIntent &&
                    !intentAnalysis.hasCommandWord &&
                    !intentAnalysis.hasRequestPattern) {
                    this.logger.log(`[스킵] 질문/명령 아님`);
                    return;
                }

                context.lastInteractionTime = Date.now();

                // ========================================
                // 8. 검색 키워드 준비
                // ========================================
                let finalSearchKeyword = searchKeyword;
                let finalSearchType = searchType || 'news';

                // 키워드가 없거나 짧으면 LLM으로 추출
                if (!finalSearchKeyword || finalSearchKeyword.length < 2) {
                    this.logger.log(`[키워드 추출] LLM buildSearchPlan 호출`);
                    const searchPlan = await this.llmService.buildSearchPlan(processedText);
                    finalSearchKeyword = searchPlan.query;
                    finalSearchType = searchPlan.searchType;
                    category = searchPlan.category || category;
                }

                this.logger.log(`[검색 준비] keyword="${finalSearchKeyword}", type=${finalSearchType}, cat=${category}`);

                // ========================================
                // 9. 생각중 응답 (LLM 응답이 늦을 경우)
                // ========================================
                const thinkingPhrases = [
                    "잠깐만요, 생각해볼게요.",
                    "음… 정리해볼게요.",
                    "잠시만요, 확인하고 말씀드릴게요."
                ];
                const thinkingPhrase = thinkingPhrases[Math.floor(Math.random() * thinkingPhrases.length)];
                let thinkingSpoken = false;
                let llmResolved = false;

                const llmStart = Date.now();
                const llmPromise = this.llmService.sendMessage(processedText, intentAnalysis.searchDomain, roomName).finally(() => {
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
                this.logger.log(`[4. LLM 응답] ${llmLatency}ms - "${llmResult.text.substring(0, 50)}..."`);

                if (context.currentRequestId !== requestId) {
                    this.logger.log(`[취소됨] 더 최신 요청이 있음 (LLM 후)`);
                    return;
                }

                // ========================================
                // 10. 검색 결과 DataChannel 전송
                // ========================================
                if (llmResult.searchResults && llmResult.searchResults.length > 0) {
                    this.logger.log(`[검색 결과] ${llmResult.searchResults.length}개`);
                    const primaryResult = llmResult.searchResults[0];
                    const routeInfo = await this.llmService.getRouteInfo(primaryResult);
                    const searchMessage = {
                        type: 'search_answer',
                        text: finalResponse,
                        category: category,
                        results: llmResult.searchResults,
                        route: routeInfo || undefined,
                    };
                    const encoder = new TextEncoder();
                    const data = encoder.encode(JSON.stringify(searchMessage));
                    await context.room.localParticipant.publishData(data, { reliable: true });
                    this.logger.log(`[DataChannel 전송 완료]`);
                }

                // ========================================
                // 11. TTS + 오디오 발행
                // ========================================
                context.shouldInterrupt = false;
                context.botState = BotState.SPEAKING;
                await this.speakAndPublish(context, roomName, requestId, finalResponse);

                // 응답 완료 후 SLEEP으로 복귀
                context.botState = BotState.SLEEP;
                context.activeUserId = null;
                context.lastInteractionTime = Date.now();
                context.lastResponseTime = Date.now();

                const totalLatency = Date.now() - startTime;
                this.logger.log(`========== [완료] 총 ${totalLatency}ms ==========\n`);
            }

        } catch (error) {
            this.logger.error(`[처리 실패] ${error.message}`, error.stack);
            context.botState = BotState.ARMED;
        } finally {
            if (context.currentRequestId === requestId) {
                context.isPublishing = false;
            }
        }
    }

    private async publishAudio(roomName: string, audioSource: AudioSource, pcmBuffer: Buffer): Promise<void> {
        const SAMPLE_RATE = 16000;
        const FRAME_SIZE = 480;
        const BYTES_PER_SAMPLE = 2;
        const FRAME_BYTES = FRAME_SIZE * BYTES_PER_SAMPLE;
        const BATCH_SIZE = 4;

        this.logger.log(`[오디오 발행] 총 ${pcmBuffer.length} bytes`);

        let offset = 0;
        let frameCount = 0;
        const startTime = Date.now();

        while (offset < pcmBuffer.length) {
            const context = this.activeRooms.get(roomName);
            if (context?.shouldInterrupt) {
                this.logger.log(`[오디오 발행 중단] Barge-in`);
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

            const expectedTime = (frameCount * 30);
            const actualTime = Date.now() - startTime;
            const sleepTime = Math.max(0, expectedTime - actualTime - 10);

            if (sleepTime > 0) {
                await this.sleep(sleepTime);
            }
        }

        this.logger.log(`[오디오 발행 완료] ${frameCount} 프레임, ${Date.now() - startTime}ms`);
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
        const ttsLatency = Date.now() - ttsStart;
        this.logger.log(`[TTS] ${ttsLatency}ms - ${pcmAudio.length} bytes`);

        context.speakingStartTime = Date.now();

        if (context.currentRequestId !== requestId) {
            this.logger.log(`[취소됨] 더 최신 요청이 있음 (TTS 후)`);
            return;
        }

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

    async stopBot(roomName: string): Promise<void> {
        const context = this.activeRooms.get(roomName);
        if (context) {
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