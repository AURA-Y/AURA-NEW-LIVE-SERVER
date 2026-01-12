import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { LivekitModule } from './livekit/livekit.module';
import { McpModule } from './mcp/mcp.module';
import { StudyModule } from './study/study.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
    }),
    LivekitModule,
    McpModule,
    StudyModule,
  ],
})
export class AppModule {}
