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

interface RoomContext {
    room: Room;
    audioSource: AudioSource;
    localAudioTrack: LocalAudioTrack;
    isPublishing: boolean;
    shouldInterrupt: boolean; // Barge-in: AI 발화 중단 플래그
    currentRequestId: number; // 최신 요청 ID (이전 요청 취소용)
}

@Injectable()
export class VoiceBotService {
    private readonly logger = new Logger(VoiceBotService.name);
    private activeRooms: Map<string, RoomContext> = new Map();

    constructor(
        private configService: ConfigService,
        private sttService: SttService,
        private llmService: LlmService,
        private ttsService: TtsService,
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
        });

        room.on(RoomEvent.Disconnected, (reason?: any) => {
            this.logger.warn(`[봇 연결 끊김] 사유: ${reason || 'UNKNOWN'}`);
            this.activeRooms.delete(roomName);
        });

        try {
            await room.connect(livekitUrl, botToken);

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
            };
            this.activeRooms.set(roomName, context);

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

    private async handleAudioTrack(roomName: string, track: RemoteTrack, userId: string) {
        this.logger.log(`[오디오 처리 시작] ${userId}`);

        // 16kHz 모노로 자동 변환
        const audioStream = new AudioStream(track, 16000, 1);

        // 음성 데이터 수집 (VAD + 노이즈 필터링)
        let audioBuffer: Buffer[] = [];
        let silenceCount = 0;
        let voiceCount = 0; // 연속 발화 프레임 수

        const SILENCE_THRESHOLD = 15; // 15 프레임 (~0.5초 침묵 시 처리)
        const MIN_AUDIO_LENGTH = 16000; // 최소 1초 오디오 필요 (16kHz)
        const VOICE_AMPLITUDE_THRESHOLD = 500; // 발화로 인정할 최소 음량 (노이즈 필터링)
        const MIN_VOICE_FRAMES = 5; // 최소 5프레임 연속 발화 필요 (끼어들기용)

        const context = this.activeRooms.get(roomName);

        for await (const frame of audioStream) {
            const frameBuffer = Buffer.from(frame.data.buffer);

            // 간단한 VAD (평균 진폭 확인)
            const samples = new Int16Array(frame.data.buffer);
            const avgAmplitude = samples.reduce((sum, s) => sum + Math.abs(s), 0) / samples.length;

            // 진짜 발화인지 체크 (노이즈 필터링)
            const isVoice = avgAmplitude > VOICE_AMPLITUDE_THRESHOLD;

            if (isVoice) {
                voiceCount++;
                silenceCount = 0;
                audioBuffer.push(frameBuffer);

                // Barge-in: AI가 발화 중일 때 사용자가 말하면 중단
                if (context && context.isPublishing && voiceCount >= MIN_VOICE_FRAMES && !context.shouldInterrupt) {
                    this.logger.log(`[Barge-in] 사용자 끼어들기 감지! AI 발화 중단`);
                    context.shouldInterrupt = true;
                }
            } else if (avgAmplitude > 100) {
                // 약한 소리: 버퍼에 추가하되 voiceCount 유지
                audioBuffer.push(frameBuffer);
                silenceCount++;
            } else {
                // 침묵
                silenceCount++;
                voiceCount = 0;
            }

            // 충분한 침묵 + 최소 오디오 길이
            const totalLength = audioBuffer.reduce((sum, b) => sum + b.length, 0);
            if (silenceCount > SILENCE_THRESHOLD && totalLength > MIN_AUDIO_LENGTH) {
                const fullAudio = Buffer.concat(audioBuffer);
                audioBuffer = [];
                silenceCount = 0;
                voiceCount = 0;

                // 비동기로 처리 (블로킹 방지)
                this.processAndRespond(roomName, fullAudio, userId).catch(err => {
                    this.logger.error(`[처리 에러] ${err.message}`);
                });
            }
        }
    }

    private async processAndRespond(roomName: string, audioBuffer: Buffer, userId: string) {
        const context = this.activeRooms.get(roomName);
        if (!context) {
            this.logger.warn(`[스킵] 방 컨텍스트 없음: ${roomName}`);
            return;
        }

        // 동시 발화 방지 - currentRequestId 변경 전에 체크해야 데드락 방지
        if (context.isPublishing) {
            this.logger.log(`[스킵] 이미 발화 중`);
            return;
        }

        // 새 요청 ID 생성 (이전 요청 무효화)
        const requestId = Date.now();
        context.currentRequestId = requestId;

        const startTime = Date.now();
        this.logger.log(`\n========== [음성 처리] ${userId} ==========`);
        this.logger.log(`오디오 크기: ${audioBuffer.length} bytes`);

        try {
            context.isPublishing = true;

            // 1. STT
            const sttStart = Date.now();
            const transcript = await this.sttService.transcribeFromBuffer(audioBuffer, 'live-audio.pcm');
            const sttLatency = Date.now() - sttStart;
            this.logger.log(`[STT] ${sttLatency}ms - "${transcript}"`);

            // 최신 요청 체크
            if (context.currentRequestId !== requestId) {
                this.logger.log(`[취소됨] 더 최신 요청이 있음 (STT 후)`);
                return;
            }

            if (!transcript.trim()) {
                this.logger.log(`[스킵] 빈 텍스트`);
                return;
            }

            // 너무 짧은 텍스트(추임새)는 무시
            if (transcript.trim().length < 5) {
                this.logger.log(`[스킵] 짧은 추임새: "${transcript}"`);
                return;
            }

            // 2. LLM
            const llmStart = Date.now();
            const llmResponse = await this.llmService.sendMessage(transcript);
            const llmLatency = Date.now() - llmStart;
            this.logger.log(`[LLM] ${llmLatency}ms - "${llmResponse.substring(0, 50)}..."`);

            // 최신 요청 체크
            if (context.currentRequestId !== requestId) {
                this.logger.log(`[취소됨] 더 최신 요청이 있음 (LLM 후)`);
                return;
            }

            // 3. TTS (PCM 출력)
            const ttsStart = Date.now();
            const pcmAudio = await this.ttsService.synthesizePcm(llmResponse);
            const ttsLatency = Date.now() - ttsStart;
            this.logger.log(`[TTS] ${ttsLatency}ms - ${pcmAudio.length} bytes`);

            // 최신 요청 체크
            if (context.currentRequestId !== requestId) {
                this.logger.log(`[취소됨] 더 최신 요청이 있음 (TTS 후)`);
                return;
            }

            // 4. LiveKit으로 오디오 발행
            await this.publishAudio(roomName, context.audioSource, pcmAudio);

            const totalLatency = Date.now() - startTime;
            this.logger.log(`========== [완료] 총 ${totalLatency}ms ==========\n`);

        } catch (error) {
            this.logger.error(`[처리 실패] ${error.message}`);
        } finally {
            // 현재 요청인 경우만 상태 리셋 (경쟁 조건 방지)
            if (context.currentRequestId === requestId) {
                context.isPublishing = false;
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

    async stopBot(roomName: string): Promise<void> {
        const context = this.activeRooms.get(roomName);
        if (context) {
            await context.room.disconnect();
            this.activeRooms.delete(roomName);
            this.logger.log(`[봇 종료] ${roomName}`);
        }
    }

    isActive(roomName: string): boolean {
        return this.activeRooms.has(roomName);
    }
}
