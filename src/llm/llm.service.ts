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
        this.logger.log(`[LLM 요청] 메시지: ${userMessage.substring(0, 50)}...`);

        const payload = {
            anthropic_version: "bedrock-2023-05-31",
            max_tokens: 1000,
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
            this.logger.error(`[LLM 에러] ${error.message}`);
            throw error;
        }
    }
}
