import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { LivekitModule } from './livekit/livekit.module';
import { McpModule } from './mcp/mcp.module';
import { StudyModule } from './study/study.module';
import { PerplexityModule } from './perplexity/perplexity.module';
import { RecordingModule } from './recording/recording.module';
import { UploadModule } from './upload/upload.module';

/**
 * AURA Live Server App Module
 * - Recording 기능 추가 (2026-01-13)
 * - Upload 기능 추가 (채팅 파일 첨부)
 *
 * NOTE: Module import order matters for route registration!
 * - RecordingModule and UploadModule must come BEFORE LivekitModule
 * - LivekitModule has wildcard routes like @Get(':roomId') that could
 *   intercept more specific routes if registered first
 */
@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
    }),
    // More specific route modules FIRST (before LivekitModule's wildcards)
    RecordingModule,
    UploadModule,
    // LivekitModule has @Get(':roomId') wildcard - must be after specific routes
    LivekitModule,
    McpModule,
    StudyModule,
    PerplexityModule,
  ],
})
export class AppModule {}

