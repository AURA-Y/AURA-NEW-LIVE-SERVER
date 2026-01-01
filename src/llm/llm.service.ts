import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
    BedrockRuntimeClient,
    InvokeModelCommand,
} from '@aws-sdk/client-bedrock-runtime';

@Injectable()
export class LlmService {
    private readonly logger = new Logger(LlmService.name);
    private bedrockClient: BedrockRuntimeClient;
    private readonly modelId = 'anthropic.claude-3-haiku-20240307-v1:0';

    // Rate limiting
    private isProcessing = false;
    private lastRequestTime = 0;
    private readonly MIN_REQUEST_INTERVAL = 1000; // 최소 1초 간격
    private readonly MAX_RETRIES = 2;

    constructor(private configService: ConfigService) {
        this.bedrockClient = new BedrockRuntimeClient({
            region: this.configService.get<string>('AWS_REGION') || 'ap-northeast-2',
            credentials: {
                accessKeyId: this.configService.get<string>('AWS_ACCESS_KEY_ID'),
                secretAccessKey: this.configService.get<string>('AWS_SECRET_ACCESS_KEY'),
            },
        });
    }

    async sendMessage(userMessage: string): Promise<string> {
        // 이미 처리 중이면 스킵 (최신 요청 우선)
        if (this.isProcessing) {
            this.logger.warn(`[LLM 스킵] 이미 요청 처리 중`);
            throw new Error('LLM is busy');
        }

        // 쿨다운 체크
        const now = Date.now();
        const timeSinceLastRequest = now - this.lastRequestTime;
        if (timeSinceLastRequest < this.MIN_REQUEST_INTERVAL) {
            const waitTime = this.MIN_REQUEST_INTERVAL - timeSinceLastRequest;
            this.logger.log(`[LLM 대기] ${waitTime}ms 쿨다운`);
            await this.sleep(waitTime);
        }

        this.isProcessing = true;
        this.lastRequestTime = Date.now();

        try {
            return await this.sendWithRetry(userMessage);
        } finally {
            this.isProcessing = false;
        }
    }

    private async sendWithRetry(userMessage: string, retryCount = 0): Promise<string> {
        this.logger.log(`[LLM 요청] 메시지: ${userMessage.substring(0, 50)}...`);

        const payload = {
            anthropic_version: "bedrock-2023-05-31",
            max_tokens: 600,
            system: "You are a real-time voice assistant. Respond in Korean. Be concise: 25-55 characters only. Skip greetings and preambles. Answer directly and smartly.",
            messages: [
                {
                    role: "user",
                    content: userMessage,
                },
            ],
        };

        const command = new InvokeModelCommand({
            modelId: this.modelId,
            contentType: 'application/json',
            accept: 'application/json',
            body: JSON.stringify(payload),
        });

        try {
            const response = await this.bedrockClient.send(command);
            const responseBody = JSON.parse(new TextDecoder().decode(response.body));

            const assistantMessage = responseBody.content[0].text;
            this.logger.log(`[LLM 응답] ${assistantMessage.substring(0, 100)}...`);

            return assistantMessage;
        } catch (error) {
            // Rate limit 에러 시 재시도
            if (error.message?.includes('Too many requests') && retryCount < this.MAX_RETRIES) {
                const backoffTime = (retryCount + 1) * 2000; // 2초, 4초
                this.logger.warn(`[LLM 재시도] ${backoffTime}ms 후 재시도 (${retryCount + 1}/${this.MAX_RETRIES})`);
                await this.sleep(backoffTime);
                return this.sendWithRetry(userMessage, retryCount + 1);
            }

            this.logger.error(`[LLM 에러] ${error.message}`);
            throw error;
        }
    }

    private sleep(ms: number): Promise<void> {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}
