import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { LlmService } from './llm.service';
import { SearchService } from './search.service';
import { MapService } from './map.service';
import { RagModule } from '../rag/rag.module';

@Module({
    imports: [ConfigModule, RagModule],
    providers: [LlmService, SearchService, MapService],
    exports: [LlmService, SearchService, MapService],
})
export class LlmModule {}