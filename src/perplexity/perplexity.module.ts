import { Module } from '@nestjs/common';
import { PerplexityService } from './perplexity.service';
import { WFCEngineService } from './wfc-engine.service';
import { LlmModule } from '../llm/llm.module';

@Module({
    imports: [LlmModule],
    providers: [PerplexityService, WFCEngineService],
    exports: [PerplexityService, WFCEngineService],
})
export class PerplexityModule {}
