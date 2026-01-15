import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AgentRouterService } from './agent-router.service';
import { EvidenceRepository, OpinionService } from './evidence';
import { RagModule } from '../rag/rag.module';
import { LlmModule } from '../llm/llm.module';

/**
 * Agent 모듈
 * - LLM Function Calling 기반의 지능형 라우팅
 * - 검증된 Evidence 기반 AI 의견 제시
 */
@Module({
    imports: [
        ConfigModule,
        RagModule,
        LlmModule,
    ],
    providers: [
        AgentRouterService,
        EvidenceRepository,
        OpinionService,
    ],
    exports: [
        AgentRouterService,
        EvidenceRepository,
        OpinionService,
    ],
})
export class AgentModule {}
