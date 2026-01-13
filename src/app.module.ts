import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { LivekitModule } from './livekit/livekit.module';
import { McpModule } from './mcp/mcp.module';
import { StudyModule } from './study/study.module';
import { PerplexityModule } from './perplexity/perplexity.module';
import { RecordingModule } from './recording/recording.module';

/**
 * AURA Live Server App Module
 * - Recording 기능 추가 (2026-01-13)
 */
@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
    }),
    LivekitModule,
    McpModule,
    StudyModule,
    PerplexityModule,
    RecordingModule,
  ],
})
export class AppModule {}

