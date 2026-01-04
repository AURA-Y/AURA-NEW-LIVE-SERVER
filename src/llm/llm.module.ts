import { Module } from '@nestjs/common';
import { LlmService } from './llm.service';
import { RagModule } from '../rag/rag.module';

@Module({
    imports: [RagModule],
    providers: [LlmService],
    exports: [LlmService],
})
export class LlmModule {}
