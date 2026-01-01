import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
    PollyClient,
    SynthesizeSpeechCommand,
    OutputFormat,
    VoiceId,
    Engine,
} from '@aws-sdk/client-polly';
import { Readable } from 'stream';

@Injectable()
export class TtsService {
    private readonly logger = new Logger(TtsService.name);
    private pollyClient: PollyClient;

    constructor(private configService: ConfigService) {
        this.pollyClient = new PollyClient({
            region: this.configService.get<string>('AWS_REGION') || 'ap-northeast-2',
            credentials: {
                accessKeyId: this.configService.get<string>('AWS_ACCESS_KEY_ID'),
                secretAccessKey: this.configService.get<string>('AWS_SECRET_ACCESS_KEY'),
            },
        });
    }

    // LiveKit용 PCM 출력 (16kHz, 16-bit signed)
    async synthesizePcm(text: string): Promise<Buffer> {
        this.logger.log(`[TTS PCM 시작] 텍스트 길이: ${text.length}자`);

        const command = new SynthesizeSpeechCommand({
            Text: text,
            OutputFormat: OutputFormat.PCM,
            VoiceId: VoiceId.Seoyeon,
            Engine: Engine.NEURAL,
            SampleRate: "16000",
        });

        try {
            const response = await this.pollyClient.send(command);

            if (!response.AudioStream) {
                throw new Error('AudioStream not returned');
            }

            const audioBuffer = await this.streamToBuffer(response.AudioStream as Readable);
            this.logger.log(`[TTS PCM 완료] 오디오 크기: ${audioBuffer.length} bytes`);

            return audioBuffer;
        } catch (error) {
            this.logger.error(`[TTS PCM 에러] ${error.message}`);
            throw error;
        }
    }

    // 기존 MP3 출력 (HTTP 응답용)
    async synthesize(text: string): Promise<Buffer> {
        this.logger.log(`[TTS 시작] 텍스트 길이: ${text.length}자`);

        const command = new SynthesizeSpeechCommand({
            Text: text,
            OutputFormat: OutputFormat.MP3,
            VoiceId: VoiceId.Seoyeon,
            Engine: Engine.NEURAL,
        });

        try {
            const response = await this.pollyClient.send(command);

            if (!response.AudioStream) {
                throw new Error('AudioStream not returned');
            }

            // Stream을 Buffer로 변환
            const audioBuffer = await this.streamToBuffer(response.AudioStream as Readable);
            this.logger.log(`[TTS 완료] 오디오 크기: ${audioBuffer.length} bytes`);

            return audioBuffer;
        } catch (error) {
            this.logger.error(`[TTS 에러] ${error.message}`);
            throw error;
        }
    }

    private async streamToBuffer(stream: Readable): Promise<Buffer> {
        const chunks: Buffer[] = [];
        for await (const chunk of stream) {
            chunks.push(Buffer.from(chunk));
        }
        return Buffer.concat(chunks);
    }
}
