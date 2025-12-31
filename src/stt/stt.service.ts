import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
    TranscribeStreamingClient,
    StartStreamTranscriptionCommand,
    LanguageCode,
    MediaEncoding,
} from '@aws-sdk/client-transcribe-streaming';

@Injectable()
export class SttService {
    private readonly logger = new Logger(SttService.name);
    private transcribeClient: TranscribeStreamingClient;

    constructor(private configService: ConfigService) {
        this.transcribeClient = new TranscribeStreamingClient({
            region: this.configService.get<string>('AWS_REGION') || 'ap-northeast-2',
            credentials: {
                accessKeyId: this.configService.get<string>('AWS_ACCESS_KEY_ID'),
                secretAccessKey: this.configService.get<string>('AWS_SECRET_ACCESS_KEY'),
            },
        });
    }

    // 오디오 파일 버퍼로 STT
    async transcribeFromBuffer(audioBuffer: Buffer, fileName: string): Promise<string> {
        this.logger.log(`[파일 STT 시작] 파일: ${fileName}, 크기: ${audioBuffer.length} bytes`);

        const command = new StartStreamTranscriptionCommand({
            LanguageCode: LanguageCode.KO_KR,
            MediaSampleRateHertz: 16000,
            MediaEncoding: MediaEncoding.PCM,
            AudioStream: this.createBufferAudioGenerator(audioBuffer),
        });

        try {
            const response = await this.transcribeClient.send(command);
            const transcripts: string[] = [];

            this.logger.log(`[AWS 연결 성공] 스트림 시작...`);

            for await (const event of response.TranscriptResultStream!) {
                if (event.TranscriptEvent) {
                    const results = event.TranscriptEvent.Transcript?.Results;
                    results?.forEach((result) => {
                        if (result.IsPartial) {
                            this.logger.log(`[STT 중간결과] ${result.Alternatives![0].Transcript}`);
                        } else {
                            const transcript = result.Alternatives![0].Transcript;
                            this.logger.log(`[STT 최종결과] ${transcript}`);
                            transcripts.push(transcript || '');
                        }
                    });
                }
            }

            const fullTranscript = transcripts.join(' ');
            this.logger.log(`[STT 완료] 전체 결과: ${fullTranscript}`);
            return fullTranscript;
        } catch (error) {
            this.logger.error(`[STT 에러] ${error.message}`);
            throw error;
        }
    }

    private async *createBufferAudioGenerator(buffer: Buffer) {
        const chunkSize = 4096;
        let offset = 0;

        this.logger.log(`[오디오 스트리밍] 총 ${Math.ceil(buffer.length / chunkSize)} 청크`);

        while (offset < buffer.length) {
            const chunk = buffer.subarray(offset, offset + chunkSize);
            this.logger.debug(`[청크 전송] offset=${offset}, size=${chunk.length}`);
            yield {
                AudioEvent: {
                    AudioChunk: chunk,
                },
            };
            offset += chunkSize;
        }

        this.logger.log(`[오디오 스트리밍 완료]`);
    }
}
