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
    TrackPublishOptions,
} from '@livekit/rtc-node';
import { SttService } from '../stt/stt.service';
import { LlmService } from '../llm/llm.service';
import { TtsService } from '../tts/tts.service';

@Injectable()
export class VoiceBotService {
    private readonly logger = new Logger(VoiceBotService.name);
    private activeRooms: Map<string, Room> = new Map();

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
                await this.handleAudioTrack(room, track, participant.identity);
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
            this.activeRooms.set(roomName, room);
            this.logger.log(`[봇 입장 성공] 현재 참여자: ${room.remoteParticipants.size}명`);

            // 기존 참여자 오디오 트랙 구독
            for (const participant of room.remoteParticipants.values()) {
                if (!participant.identity.startsWith('ai-bot')) {
                    for (const publication of participant.trackPublications.values()) {
                        if (publication.track && publication.kind === TrackKind.KIND_AUDIO) {
                            this.logger.log(`[기존 오디오] ${participant.identity}`);
                            await this.handleAudioTrack(room, publication.track as RemoteTrack, participant.identity);
                        }
                    }
                }
            }
        } catch (error) {
            this.logger.error(`[봇 입장 실패] ${error.message}`);
            throw error;
        }
    }

    private async handleAudioTrack(room: Room, track: RemoteTrack, userId: string) {
        this.logger.log(`[오디오 처리 시작] ${userId}`);

        // 16kHz 모노로 자동 변환
        const audioStream = new AudioStream(track, 16000, 1);

        // 음성 데이터 수집 (침묵 감지 기반)
        let audioBuffer: Buffer[] = [];
        let silenceCount = 0;
        const SILENCE_THRESHOLD = 500; // 0.5초 침묵 시 처리
        const MIN_AUDIO_LENGTH = 8000; // 최소 0.5초 오디오 필요

        for await (const frame of audioStream) {
            const frameBuffer = Buffer.from(frame.data.buffer);
            audioBuffer.push(frameBuffer);

            // 간단한 침묵 감지 (평균 진폭 확인)
            const samples = new Int16Array(frame.data.buffer);
            const avgAmplitude = samples.reduce((sum, s) => sum + Math.abs(s), 0) / samples.length;

            if (avgAmplitude < 100) { // 침묵
                silenceCount++;
            } else {
                silenceCount = 0;
            }

            // 충분한 침묵 + 최소 오디오 길이
            const totalLength = audioBuffer.reduce((sum, b) => sum + b.length, 0);
            if (silenceCount > SILENCE_THRESHOLD && totalLength > MIN_AUDIO_LENGTH) {
                const fullAudio = Buffer.concat(audioBuffer);
                audioBuffer = [];
                silenceCount = 0;

                // 비동기로 처리 (블로킹 방지)
                this.processAndRespond(room, fullAudio, userId).catch(err => {
                    this.logger.error(`[처리 에러] ${err.message}`);
                });
            }
        }
    }

    private async processAndRespond(room: Room, audioBuffer: Buffer, userId: string) {
        const startTime = Date.now();
        this.logger.log(`\n========== [음성 처리] ${userId} ==========`);
        this.logger.log(`오디오 크기: ${audioBuffer.length} bytes`);

        try {
            // 1. STT
            const sttStart = Date.now();
            const transcript = await this.sttService.transcribeFromBuffer(audioBuffer, 'live-audio.pcm');
            const sttLatency = Date.now() - sttStart;
            this.logger.log(`[STT] ${sttLatency}ms - "${transcript}"`);

            if (!transcript.trim()) {
                this.logger.log(`[스킵] 빈 텍스트`);
                return;
            }

            // 2. LLM
            const llmStart = Date.now();
            const llmResponse = await this.llmService.sendMessage(transcript);
            const llmLatency = Date.now() - llmStart;
            this.logger.log(`[LLM] ${llmLatency}ms - "${llmResponse.substring(0, 50)}..."`);

            // 3. TTS
            const ttsStart = Date.now();
            const ttsAudio = await this.ttsService.synthesize(llmResponse);
            const ttsLatency = Date.now() - ttsStart;
            this.logger.log(`[TTS] ${ttsLatency}ms - ${ttsAudio.length} bytes`);

            // 4. LiveKit으로 응답 (TODO: MP3를 PCM으로 변환 필요)
            // 현재는 로그만 출력
            const totalLatency = Date.now() - startTime;
            this.logger.log(`========== [완료] 총 ${totalLatency}ms ==========\n`);

            // TODO: room.localParticipant.publishTrack() 로 오디오 전송
            // MP3 → PCM 변환이 필요하여 추후 구현

        } catch (error) {
            this.logger.error(`[처리 실패] ${error.message}`);
        }
    }

    async stopBot(roomName: string): Promise<void> {
        const room = this.activeRooms.get(roomName);
        if (room) {
            await room.disconnect();
            this.activeRooms.delete(roomName);
            this.logger.log(`[봇 종료] ${roomName}`);
        }
    }

    isActive(roomName: string): boolean {
        return this.activeRooms.has(roomName);
    }
}
