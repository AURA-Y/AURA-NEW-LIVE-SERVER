import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ProactiveAnalysisService } from './proactive-analysis.service';

@Module({
  imports: [ConfigModule],
  providers: [ProactiveAnalysisService],
  exports: [ProactiveAnalysisService],
})
export class ProactiveModule {}
